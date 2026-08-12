import { Elysia } from "elysia";
import { AuthModel } from "../models/auth.model.js";
import { AuthService } from "../services/auth.service.js";

export const AuthRoutes = new Elysia({ prefix: "/api/v1" })
	.post(
		"/login",
		AuthService.login,
		{
			body: AuthModel.loginBody,
			response: AuthModel.loginResponse,
			detail: {
				summary: "User login",
				description:
					"Authenticates against the IMAP server with mailbox + password.",
				tags: ["Auth"],
			},
		},
	)
	.get(
		"/me",
		AuthService.me,
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
		AuthService.logout,
		{
			response: AuthModel.logoutResponse,
			detail: {
				summary: "Logs out current user",
				description: "Clears the auth cookie.",
				tags: ["Auth"],
			},
		},
	);