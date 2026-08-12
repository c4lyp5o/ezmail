import { t } from "elysia";

export const AuthModel = {
	loginBody: t.Object({
		mailbox: t.String(),
		password: t.String(),
		rememberMe: t.Optional(t.Boolean()),
	}),

	loginResponse: t.Object({
		success: t.Boolean(),
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