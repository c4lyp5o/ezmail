import { beforeAll, describe, expect, test } from "bun:test";
import { imap } from "./helpers/fake-imap.js";
import { smtp } from "./helpers/fake-smtp.js";
import { call, login } from "./helpers/http.js";

let cookie;
beforeAll(async () => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
	cookie = await login("Profile@x.io");
});

describe("display name", () => {
	test("defaults to empty, saves, and is per mailbox", async () => {
		expect((await call("GET", "/api/v1/profile", { cookie })).json.data).toEqual({
			displayName: "",
		});
		const put = await call("PUT", "/api/v1/profile", {
			cookie,
			body: { displayName: "  Ada Lovelace  " },
		});
		expect(put.json.data.displayName).toBe("Ada Lovelace");

		const other = await login("someone-else@x.io");
		expect((await call("GET", "/api/v1/profile", { cookie: other })).json.data).toEqual({
			displayName: "",
		});
	});

	test("CR/LF can't inject headers", async () => {
		const put = await call("PUT", "/api/v1/profile", {
			cookie,
			body: { displayName: "Ada\r\nBcc: evil@x.io" },
		});
		expect(put.json.data.displayName).toBe("Ada Bcc: evil@x.io");
	});

	test("is used as the From name; a client-sent fromName is ignored", async () => {
		await call("PUT", "/api/v1/profile", { cookie, body: { displayName: "Ada" } });
		smtp.reset();
		await call("POST", "/api/v1/mail/send", {
			cookie,
			body: { to: "bob@x.io", subject: "hi", fromName: "Spoofed" },
		});
		expect(smtp.sent[0].mail.from).toEqual({ name: "Ada", address: "Profile@x.io" });
	});

	test("requires a session", async () => {
		expect((await call("GET", "/api/v1/profile")).status).toBe(401);
	});
});
