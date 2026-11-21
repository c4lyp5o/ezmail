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
			signature: "",
		});
		const put = await call("PUT", "/api/v1/profile", {
			cookie,
			body: { displayName: "  Ada Lovelace  " },
		});
		expect(put.json.data.displayName).toBe("Ada Lovelace");

		const other = await login("someone-else@x.io");
		expect((await call("GET", "/api/v1/profile", { cookie: other })).json.data).toEqual({
			displayName: "",
			signature: "",
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

describe("signature", () => {
	const put = (body, c = cookie) => call("PUT", "/api/v1/profile", { cookie: c, body });
	const get = async (c = cookie) => (await call("GET", "/api/v1/profile", { cookie: c })).json.data;

	test("round-trips with newlines normalised", async () => {
		const res = await put({ signature: "-- \r\nAda\rAnalytical Engines\u0000\n\n" });
		expect(res.status).toBe(200);
		expect(res.json.data.signature).toBe("-- \nAda\nAnalytical Engines");
		expect((await get()).signature).toBe("-- \nAda\nAnalytical Engines");
	});

	test("an empty or whitespace-only string clears it", async () => {
		await put({ signature: "Ada" });
		expect((await put({ signature: "" })).json.data.signature).toBe("");
		await put({ signature: "Ada" });
		expect((await put({ signature: " \r\n " })).json.data.signature).toBe("");
		expect((await get()).signature).toBe("");
	});

	test("over 2000 characters is rejected and nothing changes", async () => {
		await put({ signature: "keep" });
		expect((await put({ signature: "x".repeat(2001) })).status).toBe(400);
		expect((await put({ signature: "x".repeat(5000) })).status).toBe(400);
		// CRLF counts once after normalisation.
		expect((await put({ signature: "x\r\n".repeat(1000) })).status).toBe(200);
		await put({ signature: "keep" });
		expect((await put({ signature: "x".repeat(2001), displayName: "Changed" })).status).toBe(400);
		expect(await get()).toMatchObject({ signature: "keep" });
		expect((await get()).displayName).not.toBe("Changed");
	});

	test("omitting a field leaves it unchanged", async () => {
		await put({ displayName: "Ada", signature: "Sig" });
		expect((await put({ displayName: "Ada L" })).json.data).toEqual({ displayName: "Ada L", signature: "Sig" });
		expect((await put({ signature: "Sig 2" })).json.data).toEqual({ displayName: "Ada L", signature: "Sig 2" });
		expect(await get()).toEqual({ displayName: "Ada L", signature: "Sig 2" });
	});

	test("is per mailbox", async () => {
		await put({ signature: "Mine" });
		const other = await login("sig-other@x.io");
		expect((await get(other)).signature).toBe("");
		await put({ signature: "Theirs" }, other);
		expect((await get()).signature).toBe("Mine");
	});
});
