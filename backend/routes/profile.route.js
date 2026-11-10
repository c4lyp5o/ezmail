import { Elysia, t } from "elysia";
import { ProfileService } from "../services/profile.service.js";

const profileResponse = t.Object({
	success: t.Boolean(),
	message: t.Optional(t.String()),
	data: t.Optional(t.Object({ displayName: t.String(), signature: t.Optional(t.String()) })),
});

export const ProfileRoutes = new Elysia({ prefix: "/api/v1/profile" })
	.get("/", ProfileService.get, {
		response: profileResponse,
		detail: {
			summary: "Get profile",
			description: "Returns the signed-in mailbox's display name and plain-text signature.",
			tags: ["Profile"],
		},
	})
	.put("/", ProfileService.put, {
		// Omitted fields keep their saved value. The signature is limited to 2000
		// characters after newline normalisation (400 beyond); "" clears it.
		body: t.Object({
			displayName: t.Optional(t.String({ maxLength: 200 })),
			signature: t.Optional(t.String({ maxLength: 4000 })),
		}),
		response: profileResponse,
		detail: {
			summary: "Save profile",
			description:
				"Sets the display name used in the From header of sent mail and/or the plain-text signature.",
			tags: ["Profile"],
		},
	});
