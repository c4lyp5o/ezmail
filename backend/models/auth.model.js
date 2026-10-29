import { t } from "elysia";

export const AuthModel = {
	loginBody: t.Object({
		mailbox: t.String(),
		// may be empty for a TOTP (passwordless) mailbox
		password: t.Optional(t.String()),
		rememberMe: t.Optional(t.Boolean()),
	}),

	recoverBody: t.Object({ mailbox: t.String({ minLength: 1 }), code: t.String({ minLength: 1 }), password: t.String({ minLength: 1 }) }),

	loginCodeBody: t.Object({
		mailbox: t.String(),
		code: t.String(),
		rememberMe: t.Optional(t.Boolean()),
	}),

	enrollBody: t.Object({
		mailbox: t.String(),
		password: t.Optional(t.String()),
	}),

	enrollCompleteBody: t.Object({
		mailbox: t.String(),
		code: t.String(),
	}),

	totpStatusBody: t.Object({
		mailbox: t.String(),
	}),

	disableBody: t.Object({
		mailbox: t.String(),
	}),

	loginResponse: t.Object({
		success: t.Boolean(),
		totp: t.Optional(t.Boolean()),
	}),

	meResponse: t.Object({
		success: t.Boolean(),
		data: t.Object({
			mailbox: t.String(),
			llmPresent: t.Boolean(),
		}),
	}),

	logoutResponse: t.Object({
		success: t.Boolean(),
	}),
};