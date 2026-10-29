import { beforeEach, describe, expect, test } from "bun:test";
import { imap } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

let cookie;
const ids = {};

const mail = ({ id, refs, from, subject }) =>
	[
		`From: ${from}`,
		"To: t@x.io",
		`Subject: ${subject}`,
		`Message-ID: ${id}`,
		...(refs ? [`In-Reply-To: ${refs.at(-1)}`, `References: ${refs.join(" ")}`] : []),
		"",
		"body",
	].join("\r\n");

beforeEach(async () => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
	imap.addBox("Sent Mail", "\\Sent");
	cookie ??= await login("t@x.io");
	// a1 (INBOX) ← b2 (Sent, my reply) ← c3 (INBOX); plus unrelated z9
	ids.a = imap.addMessage("INBOX", {
		date: new Date("2026-10-01"),
		source: mail({ id: "<a1@x>", from: "bob@x.io", subject: "Plan" }),
	});
	ids.b = imap.addMessage("Sent Mail", {
		date: new Date("2026-10-02"),
		source: mail({ id: "<b2@x>", refs: ["<a1@x>"], from: "t@x.io", subject: "Re: Plan" }),
	});
	ids.c = imap.addMessage("INBOX", {
		date: new Date("2026-10-03"),
		source: mail({ id: "<c3@x>", refs: ["<a1@x>", "<b2@x>"], from: "bob@x.io", subject: "Re: Plan" }),
	});
	imap.addMessage("INBOX", {
		source: mail({ id: "<z9@x>", from: "spam@x.io", subject: "Plan" }),
	});
});

const thread = (folder, uid) =>
	call("GET", `/api/v1/mail/message/${encodeURIComponent(folder)}/${uid}/thread`, { cookie });

describe("conversation", () => {
	test("from the newest message: ancestors in INBOX and Sent, oldest first", async () => {
		const res = await thread("INBOX", ids.c);
		expect(res.status).toBe(200);
		expect(res.json.data.map((m) => [m.folder, m.uid])).toEqual([
			["INBOX", ids.a],
			["Sent Mail", ids.b],
			["INBOX", ids.c],
		]);
	});

	test("from the first message: finds the replies (descendants)", async () => {
		const res = await thread("INBOX", ids.a);
		expect(res.json.data.map((m) => m.uid).sort()).toEqual(
			[ids.a, ids.b, ids.c].sort(),
		);
		expect(res.json.data.find((m) => m.folder === "Sent Mail")).toBeTruthy();
	});

	test("same subject alone doesn't join a thread", async () => {
		const res = await thread("INBOX", ids.a);
		expect(res.json.data.some((m) => m.from === "spam@x.io")).toBe(false);
	});

	test("includes archived replies", async () => {
		imap.addBox("Archive", "\\Archive");
		const archived = imap.addMessage("Archive", {
			date: new Date("2026-10-04"),
			source: mail({ id: "<d4@x>", refs: ["<a1@x>", "<c3@x>"], from: "bob@x.io", subject: "Re: Plan" }),
		});
		const res = await thread("INBOX", ids.a);
		expect(res.json.data.some((m) => m.folder === "Archive" && m.uid === archived)).toBe(true);
	});
});
