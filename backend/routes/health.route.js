import { Elysia } from "elysia";

export const HealthRoute = new Elysia({ prefix: "/api/v1" }).get(
	"/health",
	() => ({ success: true, message: "ezmail is alive 💌" }),
	{
		detail: {
			summary: "Health check",
			description: "Simple liveness probe.",
			tags: ["General"],
		},
	},
);