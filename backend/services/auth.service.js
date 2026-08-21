import { ImapFlow } from "imapflow";
import { MAIL_SERVER } from "../config.js";
import { getUser } from "../plugins/auth.plugin.js";
import { isLLMPresent } from "./llm.service.js";
import { generalLogger as logger } from "../logger.js";
import {
	beginEnroll,
	completeEnroll,
	verifyLoginCode,
	totpStatus,
	disableTotp,
} from "./totp.service.js";

// Legacy-persist the mailbox password into the access cookie payload.
function cookiePayload(mailbox, password) {
	return { mailbox, password };
}

// The mailbox password travels inside the JWT cookie (required for the
// IMAP/SMTP proxy). Secure is forced ON in production so the cookie is never
// sent over plaintext HTTP; an explicit COOKIE_SECURE=true can override for
// reverse-proxy setups that terminate TLS upstream.
const COOKIE_SECURE = process.env.NODE_ENV === "production";

function setAuthCookies({ cookie, accessToken, rememberMe }) {
	cookie.ezmail_access.set({
		value: accessToken,
		httpOnly: true,
		sameSite: "strict",
		path: "/",
		secure: COOKIE_SECURE,
		maxAge: rememberMe ? 60 * 60 * 24 * 7 : 60 * 60 * 24,
	});
}

function clearAuthCookies({ cookie }) {
	cookie.ezmail_access.set({
		httpOnly: true,
		sameSite: "strict",
		secure: COOKIE_SECURE,
		path: "/",
		maxAge: 0,
	});
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
	login: async ({ body, jwt, cookie, status }) => {
		const { mailbox, password, rememberMe } = body;
		if (!mailbox || !password) {
			return status(400, {
				success: false,
				message: "Mailbox and password are required",
			});
		}

		const st = totpStatus(mailbox);
		if (st.enabled) {
			// Passwordless mailbox: the client should prompt for a code instead and
			// hit /login/code. We do NOT verify the (expect-empty) password here.
			return { success: true, totp: true };
		}

		const ok = await verifyImap(mailbox, password);
		if (!ok) {
			return status(401, {
				success: false,
				message: "Username or password is incorrect",
			});
		}

		const accessToken = await jwt.sign(
			{
				...cookiePayload(mailbox, password),
			},
			{
				expiresIn: rememberMe ? "7d" : "1d",
			},
		);
		setAuthCookies({ cookie, accessToken, rememberMe: !!rememberMe });

		const user = await getUser(jwt, cookie);
		return {
			success: true,
			data: { mailbox: user?.mailbox || mailbox, llmPresent: isLLMPresent() },
		};
	},

	// Step 2 of passwordless TOTP: verify a code and, on success, bind the
	// decrypted stored mailbox password into the session.
	loginWithCode: async ({ body, jwt, cookie, status, set }) => {
		const { mailbox, code, rememberMe } = body;
		if (!mailbox || !code) {
			return status(400, {
				success: false,
				message: "Mailbox and code are required",
			});
		}

		const res = verifyLoginCode(mailbox, String(code));
		if (!res.ok) {
			const msg =
				res.reason === "invalid-code"
					? "Invalid code. Check your authenticator and try again."
					: "TOTP is not enabled for this mailbox.";
			return status(401, { success: false, message: msg });
		}

		if (!res.password) {
			return status(500, {
				success: false,
				message: "Stored password unavailable. Re-enroll to reset.",
			});
		}

		const accessToken = await jwt.sign(
			{ ...cookiePayload(mailbox, res.password) },
			{ expiresIn: rememberMe ? "7d" : "1d" },
		);
		setAuthCookies({ cookie, accessToken, rememberMe: !!rememberMe });

		return {
			success: true,
			data: { mailbox, llmPresent: isLLMPresent() },
		};
	},

	// Enroll — step 1: verify the mailbox password against IMAP (so we know it
	// works), generate a fresh TOTP secret, store it + the encrypted password,
	// and return the QR + otpauth URI for enrollment.
	beginEnroll: async ({ body, jwt, cookie, status }) => {
		const { mailbox, password } = body;
		// Must be authed to enroll (so only you can set up your own 2FA).
		if (!mailbox || !password) {
			return status(400, {
				success: false,
				message: "Mailbox and password are required",
			});
		}
		const usr = await getUser(jwt, cookie);
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
	completeEnroll: async ({ body, jwt, cookie, status }) => {
		const { mailbox, code } = body;
		if (!mailbox || !code) {
			return status(400, {
				success: false,
				message: "Mailbox and code are required",
			});
		}
		const usr = await getUser(jwt, cookie);
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

	// Status (used by the settings modal + login screen to know which flow).
	totpStatus: async ({ body }) => {
		const { mailbox } = body || {};
		return { success: true, data: totpStatus(mailbox) };
	},

	// Disable TOTP from settings (falls back to password login).
	disableTotp: async ({ body, jwt, cookie, status }) => {
		const { mailbox } = body || {};
		if (!mailbox)
			return status(400, { success: false, message: "Mailbox is required" });
		const usr = await getUser(jwt, cookie);
		if (!usr || usr.mailbox !== mailbox) {
			return status(401, {
				success: false,
				message: "Not authorized to manage this mailbox",
			});
		}
		disableTotp(mailbox);
		return { success: true };
	},

	me: async ({ jwt, cookie, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox) {
			return status(401, { success: false, message: "Unauthorized" });
		}
		return {
			success: true,
			data: { mailbox: user.mailbox, llmPresent: isLLMPresent() },
		};
	},

	logout: async ({ cookie }) => {
		clearAuthCookies({ cookie });
		return { success: true };
	},
};
