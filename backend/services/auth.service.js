import { ImapFlow } from "imapflow";
import { MAIL_SERVER } from "../config.js";
import { getUser, SESSION_COOKIE } from "../plugins/auth.plugin.js";
import { REQUEST_TIMEOUTS } from "./imap-pool.service.js";
import { isLLMPresent } from "./llm.service.js";
import { generalLogger as logger } from "../logger.js";
import {
	beginEnroll,
	completeEnroll,
	verifyLoginCode,
	totpStatus,
	disableTotp,
	updateTotpPassword,
} from "./totp.service.js";
import { clientKey, codeLimiter, discoveryLimiter, limitKey, loginLimiter, mailboxLimiter } from "./rate-limit.service.js";
import { createSession, deleteSession } from "./session.service.js";
import { refreshFallbackPassword } from "./filter-fallback.service.js";

// Secure is forced ON in production so the session cookie is never sent over
// plaintext HTTP; an explicit COOKIE_SECURE=true can override for
// reverse-proxy setups that terminate TLS upstream.
const COOKIE_SECURE =
	process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";

const sessionTtl = (rememberMe) =>
	rememberMe ? 60 * 60 * 24 * 7 : 60 * 60 * 24;

// Pre-1.8 sessions were a JWT carrying the password; drop any leftover.
function clearLegacyCookie(cookie) {
	if (cookie.ezmail_access?.value) {
		cookie.ezmail_access.set({ value: "", path: "/", maxAge: 0 });
	}
}

function startSession({ cookie, mailbox, password, rememberMe }) {
	refreshFallbackPassword(mailbox, password);
	const ttl = sessionTtl(rememberMe);
	cookie[SESSION_COOKIE].set({
		value: createSession(mailbox, password, ttl),
		httpOnly: true,
		sameSite: "strict",
		path: "/",
		secure: COOKIE_SECURE,
		maxAge: ttl,
	});
	clearLegacyCookie(cookie);
}

function tooManyAttempts(status, set, retryAfter) {
	set.headers["Retry-After"] = String(retryAfter);
	return status(429, {
		success: false,
		message: "Too many attempts. Try again later.",
	});
}

function endSession({ cookie }) {
	deleteSession(cookie[SESSION_COOKIE]?.value);
	cookie[SESSION_COOKIE].set({
		value: "",
		httpOnly: true,
		sameSite: "strict",
		secure: COOKIE_SECURE,
		path: "/",
		maxAge: 0,
	});
	clearLegacyCookie(cookie);
}

// Verifies the mailbox + password against the IMAP server. Returns true only
// if the server accepts the credentials — no DB-anchored account involved.
async function verifyImap(mailbox, password) {
	const client = new ImapFlow({
		host: MAIL_SERVER.imapHost,
		port: MAIL_SERVER.imapPort,
		secure: MAIL_SERVER.imapSecure,
		auth: { user: mailbox, pass: password },
		logger: false,
		...REQUEST_TIMEOUTS,
	});
	try {
		await client.connect();
		return true;
	} catch (err) {
		// Do NOT leak whether the mailbox or password was wrong — same generic
		// message for both, mirroring standard webmail behavior.
		logger.warn(
			`[AUTH] IMAP auth rejected for ${mailbox} | ${err.responseText || err.message}`,
		);
		return false;
	} finally {
		await client.logout().catch(() => {});
	}
}

export const AuthService = {
	// Steps truthfully: { totp: true } when the mailbox has TOTP enabled (tell the
	// client to proceed to the code screen), otherwise logs straight in.
	login: async (ctx) => {
		const { body, cookie, status, set } = ctx;
		const { mailbox, password, rememberMe } = body;
		if (!mailbox) {
			return status(400, { success: false, message: "Mailbox is required" });
		}

		const discoveryKey = clientKey(ctx, mailbox);
		const discoveryWait = discoveryLimiter.retryAfter(discoveryKey);
		if (discoveryWait) return tooManyAttempts(status, set, discoveryWait);
		discoveryLimiter.fail(discoveryKey);
		const st = totpStatus(mailbox);
		if (st.enabled) {
			// Passwordless mailbox: the client should prompt for a code instead and
			// hit /login/code. Any password sent is ignored (may be empty).
			return { success: true, totp: true };
		}

		if (!password) {
			return status(400, {
				success: false,
				message: "Mailbox and password are required",
			});
		}

		const wide = limitKey(mailbox);
		const wideWait = mailboxLimiter.retryAfter(wide);
		if (wideWait) return tooManyAttempts(status, set, wideWait);
		const attempt = loginLimiter.reserve(discoveryKey);
		if (attempt.wait) return tooManyAttempts(status, set, attempt.wait);
		const ok = await verifyImap(mailbox, password);
		attempt.settle(ok);
		if (!ok) {
			mailboxLimiter.fail(wide);
			return status(401, {
				success: false,
				message: "Username or password is incorrect",
			});
		}

		discoveryLimiter.reset(discoveryKey);
		mailboxLimiter.reset(wide);
		startSession({ cookie, mailbox, password, rememberMe: !!rememberMe });
		return {
			success: true,
			data: { mailbox, llmPresent: isLLMPresent() },
		};
	},

	// Step 2 of passwordless TOTP: verify a code and, on success, bind the
	// decrypted stored mailbox password into the session.
	loginWithCode: async ({ body, cookie, status, set }) => {
		const { mailbox, code, rememberMe } = body;
		if (!mailbox || !code) {
			return status(400, {
				success: false,
				message: "Mailbox and code are required",
			});
		}

		const key = limitKey(mailbox);
		const wait = codeLimiter.retryAfter(key);
		if (wait) return tooManyAttempts(status, set, wait);

		const res = verifyLoginCode(mailbox, String(code), { consume: true });
		if (!res.ok) {
			codeLimiter.fail(key);
			const msg =
				res.reason === "invalid-code"
					? "Invalid code. Check your authenticator and try again."
					: "TOTP is not enabled for this mailbox.";
			return status(401, { success: false, message: msg });
		}

		codeLimiter.reset(key);

		if (!res.password) {
			return status(500, {
				success: false,
				message: "Stored password unavailable. Re-enroll to reset.",
			});
		}

		startSession({
			cookie,
			mailbox,
			password: res.password,
			rememberMe: !!rememberMe,
		});

		return {
			success: true,
			data: { mailbox, llmPresent: isLLMPresent() },
		};
	},

	// Refresh stored IMAP credentials only after verifying both factors.
	recover: async ({ body, status, set }) => {
		const { mailbox, code, password } = body;
		const key = limitKey(mailbox);
		const attempt = codeLimiter.reserve(key);
		if (attempt.wait) return tooManyAttempts(status, set, attempt.wait);
		const result = verifyLoginCode(mailbox, String(code));
		if (!result.ok || !(await verifyImap(mailbox, password))) {
			attempt.settle(false);
			return status(401, { success: false, message: "Invalid code or mailbox password" });
		}
		if (!verifyLoginCode(mailbox, String(code), { consume: true }).ok) {
			attempt.settle(false);
			return status(401, { success: false, message: "Invalid code or mailbox password" });
		}
		updateTotpPassword(mailbox, password);
		refreshFallbackPassword(mailbox, password);
		attempt.settle(true);
		return { success: true };
	},

	// Enroll — step 1: verify the mailbox password against IMAP (so we know it
	// works), generate a fresh TOTP secret, store it + the encrypted password,
	// and return the QR + otpauth URI for enrollment.
	beginEnroll: async ({ body, cookie, status }) => {
		const { mailbox, password } = body;
		// Must be authed to enroll (so only you can set up your own 2FA).
		if (!mailbox || !password) {
			return status(400, {
				success: false,
				message: "Mailbox and password are required",
			});
		}
		const usr = await getUser(cookie);
		if (!usr || usr.mailbox !== mailbox) {
			return status(401, {
				success: false,
				message: "Not authorized to manage this mailbox",
			});
		}
		// Keep enrollment password-only → fall back to code check next.
		const ok = await verifyImap(mailbox, password);
		if (!ok) {
			return status(401, {
				success: false,
				message: "Username or password is incorrect",
			});
		}

		const { secret, qrCode, otpauthUri } = beginEnroll(mailbox, password);
		return {
			success: true,
			data: { secret, qrCode, otpauthUri },
		};
	},

	// Enroll — step 2: validate the 6-digit code to activate TOTP.
	completeEnroll: async ({ body, cookie, status }) => {
		const { mailbox, code } = body;
		if (!mailbox || !code) {
			return status(400, {
				success: false,
				message: "Mailbox and code are required",
			});
		}
		const usr = await getUser(cookie);
		if (!usr || usr.mailbox !== mailbox) {
			return status(401, {
				success: false,
				message: "Not authorized to manage this mailbox",
			});
		}
		const res = completeEnroll(mailbox, String(code));
		if (!res.ok) return status(400, { success: false, message: res.message });
		return { success: true };
	},

	// Status for the signed-in mailbox (settings modal). Session-only, so it
	// can't be used to probe which mailboxes have TOTP.
	totpStatus: async ({ body, cookie, status }) => {
		const { mailbox } = body || {};
		const usr = await getUser(cookie);
		if (!usr || usr.mailbox !== mailbox) {
			return status(401, {
				success: false,
				message: "Not authorized to manage this mailbox",
			});
		}
		return { success: true, data: totpStatus(mailbox) };
	},

	// Disable TOTP from settings (falls back to password login).
	disableTotp: async ({ body, cookie, status }) => {
		const { mailbox } = body || {};
		if (!mailbox)
			return status(400, { success: false, message: "Mailbox is required" });
		const usr = await getUser(cookie);
		if (!usr || usr.mailbox !== mailbox) {
			return status(401, {
				success: false,
				message: "Not authorized to manage this mailbox",
			});
		}
		disableTotp(mailbox);
		return { success: true };
	},

	me: async ({ cookie, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox) {
			return status(401, { success: false, message: "Unauthorized" });
		}
		return {
			success: true,
			data: { mailbox: user.mailbox, llmPresent: isLLMPresent() },
		};
	},

	logout: async ({ cookie }) => {
		endSession({ cookie });
		return { success: true };
	},
};
