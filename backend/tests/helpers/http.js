import { app } from "../../index.js";
import { PASSWORD } from "./fake-imap.js";

// Drives the real Elysia app (plugins, guards, response models) in-process.
export async function call(method, path, { body, cookie } = {}) {
	const headers = {};
	if (body) headers["content-type"] = "application/json";
	if (cookie) headers.cookie = cookie;
	const res = await app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		}),
	);
	const json = await res.json().catch(() => null);
	return { status: res.status, json, headers: res.headers };
}

// Logs in and returns the session cookie ("ezmail_session=...").
export async function login(mailbox, password = PASSWORD) {
	const res = await call("POST", "/api/v1/login", {
		body: { mailbox, password },
	});
	if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
	return res.headers.get("set-cookie").split(";")[0];
}
