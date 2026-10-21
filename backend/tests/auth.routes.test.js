import { beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";
import { imap, PASSWORD } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

// The limiters are module-global, so every test uses its own mailbox.
let n = 0;
const fresh = () => `user${++n}-${Date.now()}@x.io`;

beforeEach(() => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
});

const totpCode = (mailbox, secret) =>
	new OTPAuth.TOTP({
		issuer: "ezmail",
		label: mailbox,
		secret: OTPAuth.Secret.fromBase32(secret),
	}).generate();

describe("password login", () => {
	test("sets an HttpOnly session cookie and /me returns the mailbox", async () => {
		const mailbox = fresh();
		const res = await call("POST", "/api/v1/login", {
			body: { mailbox, password: PASSWORD },
		});
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie");
		expect(setCookie).toContain("ezmail_session=");
		expect(setCookie).toMatch(/HttpOnly/i);
		expect(setCookie).toMatch(/SameSite=Strict/i);

		const me = await call("GET", "/api/v1/me", {
			cookie: setCookie.split(";")[0],
		});
		expect(me.json.data.mailbox).toBe(mailbox);
	});

	test("wrong password gets the generic 401", async () => {
		const res = await call("POST", "/api/v1/login", {
			body: { mailbox: fresh(), password: "nope" },
		});
		expect(res.status).toBe(401);
		expect(res.json.message).toBe("Username or password is incorrect");
	});

	test("locks the mailbox after 10 failures, even for the right password", async () => {
		const mailbox = fresh();
		for (let i = 0; i < 10; i++) {
			const r = await call("POST", "/api/v1/login", {
				body: { mailbox, password: "nope" },
			});
			expect(r.status).toBe(401);
		}
		const locked = await call("POST", "/api/v1/login", {
			body: { mailbox: mailbox.toUpperCase(), password: PASSWORD },
		});
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	test("a successful login resets the failure count", async () => {
		const mailbox = fresh();
		for (let i = 0; i < 9; i++) {
			await call("POST", "/api/v1/login", {
				body: { mailbox, password: "nope" },
			});
		}
		await login(mailbox);
		for (let i = 0; i < 9; i++) {
			const r = await call("POST", "/api/v1/login", {
				body: { mailbox, password: "nope" },
			});
			expect(r.status).toBe(401);
		}
	});
});

describe("TOTP login", () => {
	async function enroll(mailbox) {
		const cookie = await login(mailbox);
		const begin = await call("POST", "/api/v1/totp/begin", {
			body: { mailbox, password: PASSWORD },
			cookie,
		});
		expect(begin.status).toBe(200);
		const { secret } = begin.json.data;
		const done = await call("POST", "/api/v1/totp/complete", {
			body: { mailbox, code: totpCode(mailbox, secret) },
			cookie,
		});
		expect(done.status).toBe(200);
		return { secret, cookie };
	}

	test("cannot enroll another user's mailbox", async () => {
		const cookie = await login(fresh());
		const res = await call("POST", "/api/v1/totp/begin", {
			body: { mailbox: fresh(), password: PASSWORD },
			cookie,
		});
		expect(res.status).toBe(401);
	});

	test("enrolled mailbox logs in with a code alone", async () => {
		const mailbox = fresh();
		const { secret } = await enroll(mailbox);

		// Step 1 still requires a non-empty password field, but for a TOTP
		// mailbox it is not checked against IMAP.
		const step1 = await call("POST", "/api/v1/login", {
			body: { mailbox, password: "ignored" },
		});
		expect(step1.json).toEqual({ success: true, totp: true });

		const step2 = await call("POST", "/api/v1/login/code", {
			body: { mailbox, code: totpCode(mailbox, secret) },
		});
		expect(step2.status).toBe(200);
		expect(step2.headers.get("set-cookie")).toContain("ezmail_session=");
	});

	test("locks code login after 5 wrong codes", async () => {
		const mailbox = fresh();
		const { secret } = await enroll(mailbox);
		for (let i = 0; i < 5; i++) {
			const r = await call("POST", "/api/v1/login/code", {
				body: {
					mailbox,
					code: totpCode(mailbox, secret) === "000000" ? "111111" : "000000",
				},
			});
			expect(r.status).toBe(401);
		}
		const locked = await call("POST", "/api/v1/login/code", {
			body: { mailbox, code: totpCode(mailbox, secret) },
		});
		expect(locked.status).toBe(429);
	});

	test("disable falls back to password login", async () => {
		const mailbox = fresh();
		const { cookie } = await enroll(mailbox);
		const off = await call("POST", "/api/v1/totp/disable", {
			body: { mailbox },
			cookie,
		});
		expect(off.status).toBe(200);
		const st = await call("POST", "/api/v1/totp/status", { body: { mailbox } });
		expect(st.json.data).toEqual({ enabled: false, enrolled: false });
		await login(mailbox);
	});
});

test("protected routes reject requests without a session", async () => {
	const res = await call("GET", "/api/v1/mail/folders");
	expect(res.status).toBe(401);
});
