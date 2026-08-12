import { ImapFlow } from "imapflow";
import { MAIL_SERVER } from "../config.js";
import { getUser } from "../plugins/auth.plugin.js";
import { isLLMPresent } from "./llm.service.js";
import { generalLogger as logger } from "../logger.js";

// The mailbox password travels inside the JWT cookie (required for the
// IMAP/SMTP proxy). Secure is forced ON in production so the cookie is never
// sent over plaintext HTTP; an explicit COOKIE_SECURE=true can override for
// reverse-proxy setups that terminate TLS upstream.
const COOKIE_SECURE =
	process.env.COOKIE_SECURE === "true" ||
	process.env.NODE_ENV === "production";

function setAuthCookies({ cookie, accessToken, rememberMe }) {
	cookie.ezmail_access.set({
		value: accessToken,
		httpOnly: true,
		sameSite: "strict",
		secure: COOKIE_SECURE,
		path: "/",
		maxAge: rememberMe ? 60 * 60 * 24 * 7 : 24 * 60 * 60,
	});
}

function clearAuthCookies({ cookie }) {
	cookie.ezmail_access.set({
		value: "",
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
	login: async ({ body, jwt, cookie, status }) => {
		const { mailbox, password, rememberMe } = body;
		if (!mailbox || !password) {
			return status(400, { success: false, message: "Mailbox and password are required" });
		}

		const ok = await verifyImap(mailbox, password);
		if (!ok) {
			return status(401, { success: false, message: "Username or password is incorrect" });
		}

		const accessToken = await jwt.sign({
			mailbox,
			password,
		}, { expiresIn: rememberMe ? "7d" : "1d" });

		setAuthCookies({ cookie, accessToken, rememberMe: !!rememberMe });
		logger.info(`[AUTH] ${mailbox} logged in`);
		return { success: true };
	},

	me: async ({ jwt, cookie, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });
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