import { beforeEach, describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";
import { imap, PASSWORD } from "./helpers/fake-imap.js";
import { app } from "../index.js";
import { call, login } from "./helpers/http.js";

// The limiters are module-global, so every test uses its own mailbox.
let n = 0;
const fresh = () => `user${++n}-${Date.now()}@x.io`;

beforeEach(() => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
});

const totpCode = (mailbox, secret, timestamp = Date.now()) =>
	new OTPAuth.TOTP({
		issuer: "ezmail",
		label: mailbox,
		secret: OTPAuth.Secret.fromBase32(secret),
	}).generate({ timestamp });

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

	test("missing password is a 400 for a non-TOTP mailbox", async () => {
		const res = await call("POST", "/api/v1/login", { body: { mailbox: fresh() } });
		expect(res.status).toBe(400);
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

		// No password needed for a TOTP mailbox.
		const step1 = await call("POST", "/api/v1/login", { body: { mailbox } });
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

	test("recovery requires both a valid code and mailbox password", async () => {
		const mailbox = fresh();
		const { secret } = await enroll(mailbox);
		const code = totpCode(mailbox, secret);
		const wrongCode = code === "000000" ? "111111" : "000000";
		for (const body of [
			{ mailbox, code: wrongCode, password: PASSWORD },
			{ mailbox, code, password: "wrong" },
		]) {
			const response = await call("POST", "/api/v1/totp/recover", { body });
			expect(response.status).toBe(401);
		}
		const response = await call("POST", "/api/v1/totp/recover", {
			body: { mailbox, code, password: PASSWORD },
		});
		expect(response.status).toBe(200);
		// Recovery consumed that code; the next time step still works.
		const replay = await call("POST", "/api/v1/login/code", { body: { mailbox, code } });
		expect(replay.status).toBe(401);
		const next = await call("POST", "/api/v1/login/code", { body: { mailbox, code: totpCode(mailbox, secret, Date.now() + 30_000) } });
		expect(next.status).toBe(200);
	});

	test("a code cannot be used twice", async () => {
		const mailbox = fresh();
		const { secret } = await enroll(mailbox);
		const code = totpCode(mailbox, secret);
		expect((await call("POST", "/api/v1/login/code", { body: { mailbox, code } })).status).toBe(200);
		expect((await call("POST", "/api/v1/login/code", { body: { mailbox, code } })).status).toBe(401);
	});

	test("a pending re-enrollment leaves the existing code usable", async () => {
		const mailbox = fresh();
		const { secret, cookie } = await enroll(mailbox);
		const begin = await call("POST", "/api/v1/totp/begin", {
			body: { mailbox, password: PASSWORD }, cookie,
		});
		expect(begin.status).toBe(200);
		const response = await call("POST", "/api/v1/login/code", {
			body: { mailbox, code: totpCode(mailbox, secret) },
		});
		expect(response.status).toBe(200);
	});

	test("disable falls back to password login", async () => {
		const mailbox = fresh();
		const { cookie } = await enroll(mailbox);
		const off = await call("POST", "/api/v1/totp/disable", {
			body: { mailbox },
			cookie,
		});
		expect(off.status).toBe(200);
		const st = await call("POST", "/api/v1/totp/status", {
			body: { mailbox },
			cookie,
		});
		expect(st.json.data).toEqual({ enabled: false, enrolled: false });
		await login(mailbox);
	});
});

test("TOTP status can't be probed for other mailboxes", async () => {
	const victim = fresh();
	const anon = await call("POST", "/api/v1/totp/status", { body: { mailbox: victim } });
	expect(anon.status).toBe(401);
	const cookie = await login(fresh());
	const other = await call("POST", "/api/v1/totp/status", {
		body: { mailbox: victim },
		cookie,
	});
	expect(other.status).toBe(401);
});

test("protected routes reject requests without a session", async () => {
	const res = await call("GET", "/api/v1/mail/folders");
	expect(res.status).toBe(401);
});

describe("login throttling per client", () => {
	const from = (ip) => ({ "x-forwarded-for": `10.0.0.9, ${ip}` });
	const attempt = (mailbox, password, ip) =>
		app.handle(new Request("http://localhost/api/v1/login", {
			method: "POST",
			headers: { "content-type": "application/json", ...from(ip) },
			body: JSON.stringify({ mailbox, password }),
		}));

	test("one client's failures do not lock the mailbox for others", async () => {
		process.env.TRUST_PROXY = "true";
		try {
			const mailbox = fresh();
			for (let i = 0; i < 10; i++) expect((await attempt(mailbox, "nope", "203.0.113.1")).status).toBe(401);
			expect((await attempt(mailbox, PASSWORD, "203.0.113.1")).status).toBe(429);
			expect((await attempt(mailbox, PASSWORD, "203.0.113.2")).status).toBe(200);
		} finally {
			delete process.env.TRUST_PROXY;
		}
	});

	test("logins from many clients still hit a mailbox-wide ceiling", async () => {
		process.env.TRUST_PROXY = "true";
		try {
			const mailbox = fresh();
			for (let i = 0; i < 100; i++) await attempt(mailbox, "nope", `198.51.100.${i % 250}.${i}`);
			expect((await attempt(mailbox, PASSWORD, "192.0.2.1")).status).toBe(429);
		} finally {
			delete process.env.TRUST_PROXY;
		}
	});
});
