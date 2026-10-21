import { Elysia, t } from "elysia";
import { ProfileService } from "../services/profile.service.js";

const profileResponse = t.Object({
	success: t.Boolean(),
	message: t.Optional(t.String()),
	data: t.Optional(t.Object({ displayName: t.String() })),
});

export const ProfileRoutes = new Elysia({ prefix: "/api/v1/profile" })
	.get("/", ProfileService.get, {
		response: profileResponse,
		detail: {
			summary: "Get profile",
			description: "Returns the signed-in mailbox's display name.",
			tags: ["Profile"],
		},
	})
	.put("/", ProfileService.put, {
		body: t.Object({ displayName: t.String({ maxLength: 200 }) }),
		response: profileResponse,
		detail: {
			summary: "Save profile",
			description: "Sets the display name used in the From header of sent mail.",
			tags: ["Profile"],
		},
	});
