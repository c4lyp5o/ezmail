import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../index.js";
import { imap } from "./helpers/fake-imap.js";
import { smtp } from "./helpers/fake-smtp.js";
import { call, login } from "./helpers/http.js";

const ME = "drafts@x.io";
let cookie;

beforeAll(async () => {
	imap.reset();
	imap.addBox("INBOX");
	cookie = await login(ME);
});

beforeEach(() => {
	imap.reset();
	smtp.reset();
	imap.addBox("INBOX", "\\Inbox");
	imap.addBox("Sent", "\\Sent");
	imap.addBox("Drafts", "\\Drafts");
});

const get = (path) => call("GET", `/api/v1/mail${path}`, { cookie });
const post = (path, body) => call("POST", `/api/v1/mail${path}`, { body, cookie });
const drafts = () => imap.boxes.get("Drafts").messages;

const draft = {
	to: "bob@x.io",
	cc: "carol@x.io",
	bcc: "hidden@x.io",
	subject: "Re: plans",
	text: "half written",
	html: "<p>half written</p>",
	inReplyTo: "<m2@x.io>",
	references: "<m1@x.io> <m2@x.io>",
};

async function download(path) {
	const res = await app.handle(new Request(`http://localhost/api/v1/mail${path}`, { headers: { cookie } }));
	return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

describe("save draft", () => {
	test("stores it in Drafts flagged \\Draft \\Seen and returns its UID", async () => {
		const res = await post("/drafts", draft);
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ uid: 1, folder: "Drafts" });
		expect(drafts()).toHaveLength(1);
		expect([...drafts()[0].flags].sort()).toEqual(["\\Draft", "\\Seen"]);
		expect(smtp.sent).toHaveLength(0);

		const list = await get("/messages/Drafts");
		expect(list.json.data.messages[0]).toMatchObject({ uid: 1, subject: "Re: plans", seen: true });
		expect(list.json.data.messages[0].flags).toContain("\\Draft");
	});

	test("re-opens with everything the composer needs, Bcc included", async () => {
		const { json } = await post("/drafts", draft);
		const res = await get(`/message/Drafts/${json.data.uid}`);
		expect(res.status).toBe(200);
		const m = res.json.data;
		expect(m.flags).toContain("\\Draft");
		expect(m.to).toBe("bob@x.io");
		expect(m.cc).toBe("carol@x.io");
		expect(m.bcc).toBe("hidden@x.io");
		expect(m.addresses.bcc).toEqual(["hidden@x.io"]);
		expect(m.subject).toBe("Re: plans");
		expect(m.text.trim()).toBe("half written");
		expect(m.html).toContain("<p>half written</p>");
		expect(m.inReplyTo).toBe("<m2@x.io>");
		expect(m.references).toBe("<m1@x.io> <m2@x.io>");
	});

	test("a half-written draft needs no fields at all", async () => {
		const res = await post("/drafts", {});
		expect(res.status).toBe(200);
		const m = (await get(`/message/Drafts/${res.json.data.uid}`)).json.data;
		expect(m.to).toBe("");
		expect(m.bcc).toBeUndefined();
	});

	test("bcc stays undefined on ordinary messages", async () => {
		const uid = imap.addMessage("INBOX", { subject: "plain" });
		const m = (await get(`/message/INBOX/${uid}`)).json.data;
		expect(m.bcc).toBeUndefined();
		expect(m.addresses.bcc).toBeUndefined();
	});

	test("replaces removes the previous draft only after the new one is stored", async () => {
		const first = (await post("/drafts", draft)).json.data.uid;
		imap.calls = [];
		const res = await post("/drafts", { ...draft, text: "more", replaces: first });
		expect(res.json.data).toEqual({ uid: 2, folder: "Drafts", replaced: true });
		expect(drafts().map((m) => m.uid)).toEqual([2]);
		const order = imap.calls.map((c) => c.cmd);
		expect(order.indexOf("append")).toBeLessThan(order.indexOf("messageDelete"));
		expect(imap.calls.find((c) => c.cmd === "messageDelete")).toMatchObject({ path: "Drafts", uids: [first] });
	});

	for (const mode of [true, "undefined"]) {
		test(`append failure (${mode === true ? "server NO" : "resolves undefined"}) is a 502 and the old draft is untouched`, async () => {
			const first = (await post("/drafts", draft)).json.data.uid;
			imap.failAppend = mode;
			imap.calls = [];
			const res = await post("/drafts", { ...draft, replaces: first });
			expect(res.status).toBe(502);
			expect(res.json.success).toBe(false);
			expect(drafts().map((m) => m.uid)).toEqual([first]);
			expect(imap.calls.some((c) => c.cmd === "messageDelete")).toBe(false);
		});
	}

	test("without UIDPLUS the UID is recovered by Message-ID and replaces still works", async () => {
		imap.uidplus = false;
		const first = await post("/drafts", draft);
		expect(first.status).toBe(200);
		expect(first.json.data).toEqual({ uid: 1, folder: "Drafts" });
		const second = await post("/drafts", { ...draft, text: "more", replaces: first.json.data.uid });
		expect(second.json.data).toEqual({ uid: 2, folder: "Drafts", replaced: true });
		expect(drafts().map((m) => m.uid)).toEqual([2]);
		const search = imap.calls.filter((c) => c.cmd === "search").at(-1);
		expect(Object.keys(search.query.header)).toEqual(["message-id"]);
	});

	test("without UIDPLUS a failed lookup still saves, without a UID", async () => {
		imap.uidplus = false;
		imap.failSearch = true;
		const res = await post("/drafts", draft);
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ folder: "Drafts" });
		expect(drafts()).toHaveLength(1);
	});

	test("out-of-range UIDs are rejected by validation", async () => {
		expect((await post("/drafts/discard", { uid: 99999999999 })).status).toBe(400);
		expect((await post("/drafts", { ...draft, replaces: 99999999999 })).status).toBe(400);
		expect((await post("/drafts/discard", { uid: 4294967295 })).status).toBe(200);
	});

	test("replaces pointing at a non-draft or a missing UID is ignored", async () => {
		const notDraft = imap.addMessage("Drafts", { subject: "keep me" });
		const res = await post("/drafts", { ...draft, replaces: notDraft });
		expect(res.status).toBe(200);
		expect(res.json.data.replaced).toBe(false);
		const missing = await post("/drafts", { ...draft, replaces: 999 });
		expect(missing.json.data.replaced).toBe(false);
		expect(drafts().map((m) => m.envelope.subject)).toEqual(["keep me", "Re: plans", "Re: plans"]);
	});

	test("a failed removal of the old draft does not fail the save", async () => {
		const first = (await post("/drafts", draft)).json.data.uid;
		imap.failDelete = true;
		const res = await post("/drafts", { ...draft, replaces: first });
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ uid: 2, folder: "Drafts", replaced: false });
		expect(drafts()).toHaveLength(2);
	});

	test("creates Drafts when the account has none", async () => {
		imap.boxes.delete("Drafts");
		const res = await post("/drafts", draft);
		expect(res.status).toBe(200);
		expect(res.json.data.folder).toBe("Drafts");
		expect(imap.boxes.get("Drafts").messages).toHaveLength(1);
	});

	test("finds Drafts by its \\Drafts role, whatever it's called", async () => {
		imap.boxes.delete("Drafts");
		imap.addBox("Brouillons", "\\Drafts");
		const res = await post("/drafts", draft);
		expect(res.json.data.folder).toBe("Brouillons");
		expect(imap.boxes.has("Drafts")).toBe(false);
	});

	test("uploaded and forwarded attachments are stored and can be carried to the next save", async () => {
		const pdf = Buffer.from("%PDF-1.4 draft bytes");
		const first = await post("/drafts", {
			...draft,
			attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: pdf.toString("base64") }],
		});
		const uid = first.json.data.uid;
		const opened = (await get(`/message/Drafts/${uid}`)).json.data;
		expect(opened.attachments.map((a) => a.filename)).toEqual(["a.pdf"]);
		expect((await download(`/message/Drafts/${uid}/attachment/0`)).bytes.equals(pdf)).toBe(true);

		// Resuming: the draft's own attachments are forwarded into its replacement.
		const next = await post("/drafts", {
			...draft,
			forwardAttachments: { folder: "Drafts", uid, indexes: [0] },
			replaces: uid,
		});
		expect(next.json.data.replaced).toBe(true);
		const reopened = (await get(`/message/Drafts/${next.json.data.uid}`)).json.data;
		expect(reopened.attachments.map((a) => a.filename)).toEqual(["a.pdf"]);
		expect((await download(`/message/Drafts/${next.json.data.uid}/attachment/0`)).bytes.equals(pdf)).toBe(true);
	});

	test("a missing forwarded attachment is a 400 and nothing is stored", async () => {
		const res = await post("/drafts", { ...draft, forwardAttachments: { folder: "INBOX", uid: 42, indexes: [0] } });
		expect(res.status).toBe(400);
		expect(drafts()).toHaveLength(0);
	});

	test("validates the body", async () => {
		expect((await post("/drafts", { replaces: "abc" })).status).toBe(400);
		expect((await post("/drafts", { replaces: 0 })).status).toBe(400);
		expect((await post("/drafts", { to: 5 })).status).toBe(400);
		expect((await post("/drafts", { attachments: [{}] })).status).toBe(400);
		expect(drafts()).toHaveLength(0);
	});

	test("requires a session", async () => {
		const res = await call("POST", "/api/v1/mail/drafts", { body: draft });
		expect(res.status).toBe(401);
		expect(drafts()).toHaveLength(0);
	});
});

describe("discard draft", () => {
	test("removes a draft and is idempotent", async () => {
		const uid = (await post("/drafts", draft)).json.data.uid;
		const res = await post("/drafts/discard", { uid });
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ uid, removed: true, folder: "Drafts" });
		expect(drafts()).toHaveLength(0);
		const again = await post("/drafts/discard", { uid });
		expect(again.status).toBe(200);
		expect(again.json.data).toEqual({ uid, removed: false, folder: "Drafts" });
	});

	test("never removes a message without the \\Draft flag", async () => {
		const uid = imap.addMessage("Drafts", { subject: "not a draft" });
		const res = await post("/drafts/discard", { uid });
		expect(res.json.data.removed).toBe(false);
		expect(drafts()).toHaveLength(1);
	});

	test("only ever touches the Drafts folder", async () => {
		const inboxUid = imap.addMessage("INBOX");
		imap.boxes.get("INBOX").messages[0].flags.add("\\Draft");
		const res = await post("/drafts/discard", { uid: inboxUid });
		expect(res.json.data.removed).toBe(false);
		expect(imap.boxes.get("INBOX").messages).toHaveLength(1);
	});

	test("without a Drafts folder nothing is created or removed", async () => {
		imap.boxes.delete("Drafts");
		const res = await post("/drafts/discard", { uid: 1 });
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ uid: 1, removed: false });
		expect(imap.boxes.has("Drafts")).toBe(false);
	});

	test("a failed delete is a 502", async () => {
		const uid = (await post("/drafts", draft)).json.data.uid;
		imap.failDelete = true;
		const res = await post("/drafts/discard", { uid });
		expect(res.status).toBe(502);
	});

	test("validates the body and requires a session", async () => {
		expect((await post("/drafts/discard", {})).status).toBe(400);
		expect((await post("/drafts/discard", { uid: "x" })).status).toBe(400);
		expect((await call("POST", "/api/v1/mail/drafts/discard", { body: { uid: 1 } })).status).toBe(401);
	});
});
