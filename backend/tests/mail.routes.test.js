import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { imap } from "./helpers/fake-imap.js";
import { smtp } from "./helpers/fake-smtp.js";
import { call, login } from "./helpers/http.js";

const ME = "mail-tests@x.io";
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
	imap.addBox("Trash", "\\Trash");
	imap.addBox("Archive", "\\Archive");
});

const get = (path) => call("GET", `/api/v1/mail${path}`, { cookie });
const post = (path, body) => call("POST", `/api/v1/mail${path}`, { body, cookie });

describe("folders", () => {
	test("reports unread counts for every folder in one LIST", async () => {
		imap.addMessage("INBOX");
		imap.addMessage("INBOX", { seen: true });
		imap.addMessage("Archive");
		const res = await get("/folders");
		expect(res.status).toBe(200);
		const unread = Object.fromEntries(res.json.data.map((f) => [f.path, f.unread]));
		expect(unread).toEqual({ INBOX: 1, Sent: 0, Trash: 0, Archive: 1 });
	});
});

describe("single-part messages", () => {
	// imapflow omits `part` on the root node of a message with no MIME multipart.
	test("show their body even though the root structure has no part number", async () => {
		const uid = imap.addMessage("INBOX", {
			subject: "plain",
			bodyStructure: { type: "text/plain", size: 5 },
			parts: { 1: Buffer.from("hello") },
		});
		const res = await get(`/message/INBOX/${uid}`);
		expect(res.status).toBe(200);
		expect(res.json.data.text).toBe("hello");
		expect(res.json.data.attachments).toEqual([]);
	});

	test("a lone attachment is listed and downloadable", async () => {
		const uid = imap.addMessage("INBOX", {
			bodyStructure: { type: "application/pdf", size: 4, disposition: "attachment", dispositionParameters: { filename: "a.pdf" } },
			parts: { 1: Buffer.from("%PDF") },
		});
		const res = await get(`/message/INBOX/${uid}`);
		expect(res.json.data.attachments.map((a) => a.filename)).toEqual(["a.pdf"]);
		const file = await call("GET", `/api/v1/mail/message/INBOX/${uid}/attachment/0`, { cookie });
		expect(file.status).toBe(200);
	});
});

describe("delete without a Trash folder", () => {
	test("creates Trash and moves the message there", async () => {
		imap.boxes.delete("Trash");
		const uid = imap.addMessage("INBOX", { subject: "bye" });
		const res = await post("/delete", { folder: "INBOX", uids: [uid] });
		expect(res.status).toBe(200);
		expect(imap.boxes.get("Trash").messages.map((m) => m.envelope.subject)).toEqual(["bye"]);
	});
});

describe("message list", () => {
	const fill = (count) => {
		for (let i = 0; i < count; i++) imap.addMessage("INBOX", { subject: `msg ${i + 1}` });
	};
	const uids = (res) => res.json.data.messages.map((m) => m.uid);

	test("newest first fetches only the requested page", async () => {
		fill(120);
		const res = await get("/messages/INBOX?page=1&pageSize=50&sort=desc");
		expect(res.json.data.total).toBe(120);
		expect(uids(res)).toEqual(Array.from({ length: 50 }, (_, i) => 120 - i));
		expect(imap.calls).toEqual([{ cmd: "fetch", range: "71:120", uid: false }]);
	});

	test("last page is partial; past the end is empty", async () => {
		fill(120);
		const p3 = await get("/messages/INBOX?page=3&pageSize=50&sort=desc");
		expect(uids(p3)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
		const p4 = await get("/messages/INBOX?page=4&pageSize=50&sort=desc");
		expect(p4.json.data.messages).toEqual([]);
		expect(p4.json.data.total).toBe(120);
	});

	test("oldest first", async () => {
		fill(60);
		const p2 = await get("/messages/INBOX?page=2&pageSize=50&sort=asc");
		expect(uids(p2)).toEqual(Array.from({ length: 10 }, (_, i) => 51 + i));
	});

	test("page size is capped at 100", async () => {
		fill(150);
		const res = await get("/messages/INBOX?page=1&pageSize=500");
		expect(res.json.data.messages).toHaveLength(100);
	});

	test("search paginates over matching UIDs only", async () => {
		fill(30);
		const res = await get("/messages/INBOX?page=1&pageSize=5&search=msg%202");
		// "msg 2" matches 2 and 20-29 → 11 hits, newest first
		expect(res.json.data.total).toBe(11);
		expect(uids(res)).toEqual([29, 28, 27, 26, 25]);
	});

	test("empty folder", async () => {
		const res = await get("/messages/Trash");
		expect(res.json.data).toMatchObject({ messages: [], total: 0 });
	});

	test("IMAP failure is a 502, not a 200 with success:false", async () => {
		const res = await get("/messages/DoesNotExist");
		expect(res.status).toBe(502);
		expect(res.json.success).toBe(false);
	});
});

describe("single message", () => {
	test("returns reply metadata and bare addresses", async () => {
		const uid = imap.addMessage("INBOX", {
			source: [
				'From: "Bob" <bob@x.io>',
				"Reply-To: replies@x.io",
				`To: ${ME}, carol@x.io`,
				"Cc: dan@x.io",
				"Subject: hello",
				"Message-ID: <m2@x.io>",
				"References: <m1@x.io>",
				"",
				"hi there",
			].join("\r\n"),
		});
		const res = await get(`/message/INBOX/${uid}`);
		expect(res.status).toBe(200);
		const m = res.json.data;
		expect(m.messageId).toBe("<m2@x.io>");
		expect(m.references).toBe("<m1@x.io>");
		expect(m.addresses).toEqual({
			from: ["bob@x.io"],
			replyTo: ["replies@x.io"],
			to: [ME, "carol@x.io"],
			cc: ["dan@x.io"],
		});
		expect(m.text.trim()).toBe("hi there");
	});
});

describe("flags, move, delete", () => {
	test("flag responses carry the fresh INBOX unread count", async () => {
		const a = imap.addMessage("INBOX");
		imap.addMessage("INBOX");
		const res = await post("/flags", { folder: "INBOX", uids: [a], flags: ["\\Seen"] });
		expect(res.json.data.inboxUnseen).toBe(1);
		const back = await post("/unflag", { folder: "INBOX", uids: [a], flags: ["\\Seen"] });
		expect(back.json.data.inboxUnseen).toBe(2);
	});

	test("move returns destination UIDs, which undo the move", async () => {
		imap.addMessage("Trash"); // destination UIDs differ from source UIDs
		const a = imap.addMessage("INBOX", { subject: "keep me" });
		const res = await post("/move", { uids: [a], from: "INBOX", to: "Trash" });
		expect(res.status).toBe(200);
		expect(res.json.data.movedUids).toEqual([2]);
		expect(imap.boxes.get("INBOX").messages).toHaveLength(0);

		const undo = await post("/move", {
			uids: res.json.data.movedUids,
			from: "Trash",
			to: "INBOX",
		});
		expect(undo.status).toBe(200);
		expect(imap.boxes.get("INBOX").messages[0].envelope.subject).toBe("keep me");
	});

	test("move without UIDPLUS omits movedUids", async () => {
		imap.uidplus = false;
		const a = imap.addMessage("INBOX");
		const res = await post("/move", { uids: [a], from: "INBOX", to: "Archive" });
		expect(res.json.data.movedUids).toBeUndefined();
	});

	test("delete in Trash is permanent and not double-wrapped", async () => {
		const a = imap.addMessage("Trash");
		const res = await post("/delete", { folder: "Trash", uids: [a] });
		expect(res.status).toBe(200);
		expect(res.json.data.uids).toEqual([a]);
		expect(imap.boxes.get("Trash").messages).toHaveLength(0);
	});

	test("Trash is found by its \\Trash role, whatever it's called", async () => {
		imap.reset();
		imap.addBox("INBOX", "\\Inbox");
		imap.addBox("Deleted Items", "\\Trash");
		const a = imap.addMessage("INBOX");
		await post("/delete", { folder: "INBOX", uids: [a] });
		expect(imap.boxes.get("Deleted Items").messages).toHaveLength(1);

		const [moved] = imap.boxes.get("Deleted Items").messages;
		await post("/delete", { folder: "Deleted Items", uids: [moved.uid] });
		expect(imap.boxes.get("Deleted Items").messages).toHaveLength(0);
	});

	test("Sent copy goes to the \\Sent folder by role", async () => {
		imap.reset();
		imap.addBox("INBOX", "\\Inbox");
		imap.addBox("Sent Mail", "\\Sent");
		await post("/send", { to: "bob@x.io", subject: "s", text: "t" });
		expect(imap.boxes.get("Sent Mail").messages).toHaveLength(1);
	});

	test("emptying an already empty Trash succeeds", async () => {
		const res = await post("/expunge", { folder: "Trash" });
		expect(res.status).toBe(200);
	});
});

describe("send", () => {
	const mail = {
		to: "bob@x.io",
		subject: "Re: hello",
		text: "thanks",
		inReplyTo: "<m2@x.io>",
		references: "<m1@x.io> <m2@x.io>",
	};

	test("sends with threading headers and files a copy in Sent", async () => {
		const res = await post("/send", mail);
		expect(res.status).toBe(200);
		expect(res.json.data.savedToSent).toBe(true);

		const sent = smtp.sent[0].mail;
		expect(sent.inReplyTo).toBe("<m2@x.io>");
		expect(sent.references).toBe("<m1@x.io> <m2@x.io>");
		// no display name set → the address
		expect(sent.from).toEqual({ name: ME, address: ME });

		const copy = imap.boxes.get("Sent").messages[0];
		expect([...copy.flags]).toEqual(["\\Seen"]);
		const raw = copy.source.toString();
		expect(raw).toContain(`Message-ID: ${sent.messageId}`);
		expect(raw).toContain("In-Reply-To: <m2@x.io>");
	});

	test("SAVE_SENT=false skips the Sent copy", async () => {
		process.env.SAVE_SENT = "false";
		try {
			const res = await post("/send", mail);
			expect(res.json.data.savedToSent).toBe(false);
			expect(imap.boxes.get("Sent").messages).toHaveLength(0);
		} finally {
			delete process.env.SAVE_SENT;
		}
	});

	test("an accepted message reports a missing Sent folder without suggesting failure", async () => {
		imap.reset();
		imap.addBox("INBOX", "\\Inbox");
		const res = await post("/send", { to: "bob@x.io", subject: "hello", text: "body" });
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ savedToSent: false, sentSavingDisabled: false });
		expect(smtp.sent).toHaveLength(1);
		expect(Buffer.isBuffer(smtp.sent[0].mail.raw)).toBe(true);
	});

	test("SMTP failure is a 502 so the UI doesn't claim it was sent", async () => {
		smtp.failNext = "relay denied";
		const res = await post("/send", mail);
		expect(res.status).toBe(502);
		expect(res.json).toEqual({ success: false, message: "relay denied" });
		expect(imap.boxes.get("Sent").messages).toHaveLength(0);
	});
});
