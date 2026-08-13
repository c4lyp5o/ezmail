import { Elysia } from "elysia";
import { AuthModel } from "../models/auth.model.js";
import { AuthService } from "../services/auth.service.js";

export const AuthRoutes = new Elysia({ prefix: "/api/v1" })
	.post(
		"/login",
		(handler) => AuthService.login(handler),
		{
			body: AuthModel.loginBody,
			response: AuthModel.loginResponse,
			detail: {
				summary: "User login",
				description:
					"Authenticates against the IMAP server with mailbox + password. Returns { totp: true } when the mailbox has TOTP enabled (client proceeds to the code step).",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/login/code",
		(handler) => AuthService.loginWithCode(handler),
		{
			body: AuthModel.loginCodeBody,
			detail: {
				summary: "Passwordless TOTP login (step 2)",
				description:
					"Verifies a 6-digit TOTP code for a mailbox with TOTP enabled and establishes the session.",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/totp/begin",
		(handler) => AuthService.beginEnroll(handler),
		{
			body: AuthModel.enrollBody,
			detail: {
				summary: "Begin TOTP enrollment",
				description:
					"Verifies the mailbox password against IMAP, generates a fresh secret, stores it (encrypted), returns the QR + otpauth URI.",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/totp/complete",
		(handler) => AuthService.completeEnroll(handler),
		{
			body: AuthModel.enrollCompleteBody,
			detail: {
				summary: "Activate TOTP",
				description:
					"Validates the 6-digit code against the pending secret and enables TOTP for the mailbox.",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/totp/status",
		(handler) => AuthService.totpStatus(handler),
		{
			body: AuthModel.totpStatusBody,
			detail: {
				summary: "TOTP status",
				description: "Returns whether the mailbox has TOTP enrolled/enabled.",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/totp/disable",
		(handler) => AuthService.disableTotp(handler),
		{
			body: AuthModel.disableBody,
			detail: {
				summary: "Disable TOTP",
				description:
					"Disables TOTP for the mailbox (falls back to password login).",
				tags: ["Auth"],
			},
		},
	)
	.get(
		"/me",
		(handler) => AuthService.me(handler),
		{
			response: AuthModel.meResponse,
			detail: {
				summary: "Returns current user",
				description: "Decodes the JWT cookie and returns the logged-in mailbox.",
				tags: ["Auth"],
			},
		},
	)
	.post(
		"/logout",
		(handler) => AuthService.logout(handler),
		{
			response: AuthModel.logoutResponse,
			detail: {
				summary: "Logs out current user",
				description: "Clears the auth cookie.",
				tags: ["Auth"],
			},
		},
	);