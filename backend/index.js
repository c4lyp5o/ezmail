import path from "node:path";
import crypto from "node:crypto";
import { Elysia, file } from "elysia";
import { cookie } from "@elysiajs/cookie";
import { jwt } from "@elysiajs/jwt";
import { openapi } from "@elysiajs/openapi";
import staticPlugin from "@elysiajs/static";
import { getSetting, setSetting } from "./db.js";
import { generalLogger as logger } from "./logger.js";
import { CLIENT_DIR, MAIL_SERVER } from "./config.js";

import { AuthPlugin } from "./plugins/auth.plugin.js";
import { ProtectorPlugin } from "./plugins/protector.plugin.js";

import { HealthRoute } from "./routes/health.route.js";
import { AuthRoutes } from "./routes/auth.route.js";
import { MailRoutes } from "./routes/mail.route.js";
import { probeAndRecordLLM } from "./services/llm.service.js";

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
	JWT_SECRET = getSetting("jwtSecret");
	if (!JWT_SECRET) {
		JWT_SECRET = crypto.randomBytes(32).toString("hex");
		setSetting("jwtSecret", JWT_SECRET);
	}
}

export const app = new Elysia()
	.onError(({ code, error, set }) => {
		if (code === "VALIDATION") {
			process.env.NODE_ENV === "development" && logger.error(error);
			set.status = 400;
			return { success: false, message: "Bad request" };
		}
		if (code === "NOT_FOUND") {
			set.status = 404;
			return { success: false, message: "Not Found" };
		}

		set.status = 500;
		logger.error(`[SERVER] 💥[${code}] Server Error: `, error);
		const message =
			process.env.NODE_ENV === "development"
				? error.message
				: "Internal Server Error";
		return { success: false, message };
	})

	.use(cookie())

	.use(
		jwt({
			name: "jwt",
			secret: JWT_SECRET,
		}),
	)

	// Security headers for every response (CSP, clickjacking, feature policy).
	.onAfterHandle(({ set }) => {
		set.headers["X-Frame-Options"] = "DENY";
		set.headers["X-Content-Type-Options"] = "nosniff";
		set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
		set.headers["Permissions-Policy"] =
			"camera=(), microphone=(), geolocation=(), payment=(), usb=()";
		set.headers["X-XSS-Protection"] = "1; mode=block";
		set.headers[
			"Content-Security-Policy"
		] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
	})

	.use(HealthRoute)

	.guard((authApi) => authApi.use(AuthPlugin).use(AuthRoutes))

	.guard((protectedApi) =>
		protectedApi
			.use(AuthPlugin)
			.use(ProtectorPlugin)
			.use(MailRoutes),
	)

	.use(
		staticPlugin({
			assets: CLIENT_DIR,
			prefix: "/",
			indexHTML: true,
			alwaysStatic: true,
			maxAge: 7 * 24 * 60 * 60,
		}),
	)

	.get("/", () => file(path.join(CLIENT_DIR, "index.html")), {
		detail: {
			hide: true,
		},
	})

	.get("/*urlPath", ({ set, path: urlPath }) => {
		// SPA fallback: serve index.html for any client-side route refresh (React Router).
		// Never intercept API/asset requests — unmatched /api/* and file paths return a real 404.
		if (urlPath.startsWith("/api") || urlPath.includes(".")) {
			set.status = 404;
			return { success: false, message: "Not Found" };
		}
		return file(path.join(CLIENT_DIR, "index.html"));
	}, {
		detail: {
			hide: true,
		},
	});

if (process.env.NODE_ENV === "development") {
	app.use(
		openapi({
			exclude: {
				paths: ["/", "/*", ""],
			},
			documentation: {
				info: {
					title: "ezmail API 💌",
					version: "0.1.0",
					description:
						"A modern webmail client backed by imapflow + nodemailer, proxying docker-mailserver.",
					contact: {
						name: "c4lyp5o",
						url: "https://github.com/c4lyp5o",
						email: "contact@example.com",
					},
					license: {
						name: "MIT",
						url: "https://opensource.org/licenses/MIT",
					},
				},
				servers: [
					{
						url: "http://localhost:5000",
						description: "Local Development Server",
					},
				],
				tags: [
					{ name: "Auth", description: "Authentication and setup" },
					{ name: "Mail", description: "IMAP folders, messages, flags, send" },
					{ name: "General", description: "System health" },
				],
			},
		}),
	);
}

const startServer = async () => {
	if (
		!MAIL_SERVER.imapHost ||
		MAIL_SERVER.imapHost === "mail.example.com" ||
		MAIL_SERVER.imapHost === "localhost"
	) {
		logger.error(
			"[SERVER] ❌ IMAP_HOST is not set or is a placeholder. Refusing to start. Set IMAP_HOST (and IMAP_PORT/IMAP_SECURE) in backend/.env, then restart.",
		);
		process.exit(1);
	}
	try {
		await probeAndRecordLLM();
		app.listen(process.env.PORT || 5000);
		process.env.NODE_ENV === "development" &&
			logger.info("[SERVER] 📘 ezmail OpenAPI UI enabled at /openapi");
		logger.info(
			`[SERVER] ezmail is running at ${app.server?.hostname}:${app.server?.port}`,
		);
	} catch (err) {
		logger.error("[SERVER] Failed to start server: ", err);
		process.exit(1);
	}
};

startServer();