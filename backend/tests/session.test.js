import { describe, expect, test } from "bun:test";
import { db } from "../db.js";
import {
	createSession,
	getSession,
	purgeExpiredSessions,
} from "../services/session.service.js";
import { imap, PASSWORD } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

describe("session store", () => {
	test("token resolves to the mailbox + decrypted password", () => {
		const token = createSession("s1@x.io", "pw-1", 60);
		expect(getSession(token)).toEqual({ mailbox: "s1@x.io", password: "pw-1" });
	});

	test("neither the token nor the password is stored in clear", () => {
		const token = createSession("s2@x.io", "very-secret-pw", 60);
		const rows = db.query("SELECT * FROM sessions").all();
		const dump = JSON.stringify(rows);
		expect(dump).not.toContain(token);
		expect(dump).not.toContain("very-secret-pw");
	});

	test("unknown, malformed and expired tokens resolve to null", () => {
		expect(getSession("nope")).toBeNull();
		expect(getSession(undefined)).toBeNull();
		expect(getSession({})).toBeNull();
		const token = createSession("s3@x.io", "pw", -1);
		expect(getSession(token)).toBeNull();
	});

	test("expired rows are purged", () => {
		createSession("s4@x.io", "pw", -1);
		purgeExpiredSessions();
		const left = db
			.query("SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?")
			.get(Date.now());
		expect(left.n).toBe(0);
	});
});

describe("session cookie", () => {
	test("carries an opaque token, not the password", async () => {
		imap.reset();
		imap.addBox("INBOX");
		const res = await call("POST", "/api/v1/login", {
			body: { mailbox: "c1@x.io", password: PASSWORD },
		});
		const cookie = res.headers.get("set-cookie");
		const value = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
		expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
		expect(cookie).not.toContain(PASSWORD);
		expect(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=")).not.toContain(
			PASSWORD,
		);
	});

	test("logout revokes the session server-side", async () => {
		imap.reset();
		imap.addBox("INBOX");
		const cookie = await login("c2@x.io");
		expect((await call("GET", "/api/v1/me", { cookie })).status).toBe(200);
		await call("POST", "/api/v1/logout", { cookie });
		// replaying the old cookie no longer works
		expect((await call("GET", "/api/v1/me", { cookie })).status).toBe(401);
		expect((await call("GET", "/api/v1/mail/folders", { cookie })).status).toBe(401);
	});

	test("a forged cookie is rejected", async () => {
		const res = await call("GET", "/api/v1/mail/folders", {
			cookie: "ezmail_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		});
		expect(res.status).toBe(401);
	});
});
