import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseSearchQuery } from "../services/search-query.js";
import { imap } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

const day = (s) => new Date(`${s}T00:00:00.000Z`);

describe("parseSearchQuery", () => {
	test("date operators produce UTC-midnight Dates", () => {
		expect(parseSearchQuery("after:2026-01-15").since.toISOString()).toBe("2026-01-15T00:00:00.000Z");
		expect(parseSearchQuery("before:2026-01-15").before.toISOString()).toBe("2026-01-15T00:00:00.000Z");
	});

	const cases = [
		// No operators: exactly today's query, raw string untouched.
		["invoice", { text: "invoice" }],
		["msg  2", { text: "msg  2" }],
		['"exact phrase" here', { text: '"exact phrase" here' }],
		["", {}],
		["from:alice", { from: "alice" }],
		["FROM:alice@x.io report", { from: "alice@x.io", text: "report" }],
		["to:bob subject:hi", { to: "bob", subject: "hi" }],
		['subject:"weekly report" draft', { subject: "weekly report", text: "draft" }],
		['From:"Ada Lovelace"', { from: "Ada Lovelace" }],
		["is:unread", { seen: false }],
		["is:READ", { seen: true }],
		["Is:starred", { flagged: true }],
		["is:unstarred x", { flagged: false, text: "x" }],
		["before:2026-01-15", { before: day("2026-01-15") }],
		["after:2025-12-31 is:unread", { since: day("2025-12-31"), seen: false }],
		["from:a from:b", { from: "b" }],
		// Fallbacks: the token stays plain text, never an error.
		["has:attachment", { text: "has:attachment" }],
		["has:attachment from:a", { from: "a", text: "has:attachment" }],
		["is:important from:a", { from: "a", text: "is:important" }],
		["before:2026-02-30 from:a", { from: "a", text: "before:2026-02-30" }],
		["after:yesterday from:a", { from: "a", text: "after:yesterday" }],
		["before:2026-1-5 from:a", { from: "a", text: "before:2026-1-5" }],
		['subject:"unclosed words from:a', { from: "a", text: 'subject:"unclosed words' }],
		['is:"unread" from:a', { from: "a", text: 'is:"unread"' }],
		['subject:"" from:a', { from: "a", text: 'subject:""' }],
		["from: alone", { text: "from: alone" }],
		["http://x.io", { text: "http://x.io" }],
	];
	for (const [input, expected] of cases) {
		test(JSON.stringify(input), () => {
			expect(parseSearchQuery(input)).toEqual(expected);
		});
	}
});

describe("search operators through the message list", () => {
	let cookie;
	beforeAll(async () => {
		imap.reset();
		imap.addBox("INBOX", "\\Inbox");
		cookie = await login("search@x.io");
	});

	beforeEach(() => {
		imap.reset();
		imap.addBox("INBOX", "\\Inbox");
		const d = (s) => new Date(`${s}T12:00:00Z`);
		imap.addMessage("INBOX", { subject: "Weekly report", from: "alice@x.io", to: "me@x.io", date: d("2026-01-10") });
		imap.addMessage("INBOX", { subject: "Lunch", from: "bob@x.io", to: "team@x.io", date: d("2026-01-15"), seen: true });
		const starred = imap.addMessage("INBOX", { subject: "Weekly sync", from: "bob@x.io", date: d("2026-01-20") });
		imap.boxes.get("INBOX").messages.find((m) => m.uid === starred).flags.add("\\Flagged");
	});

	const search = async (q) => {
		const res = await call("GET", `/api/v1/mail/messages/INBOX?search=${encodeURIComponent(q)}`, { cookie });
		expect(res.status).toBe(200);
		expect(res.json.data.search).toBe(q.trim());
		return res.json.data.messages.map((m) => m.subject).sort();
	};

	test("plain text still searches as before", async () => {
		expect(await search("weekly")).toEqual(["Weekly report", "Weekly sync"]);
	});

	test("field operators combine (AND) with free text", async () => {
		expect(await search("from:bob")).toEqual(["Lunch", "Weekly sync"]);
		expect(await search("from:bob weekly")).toEqual(["Weekly sync"]);
		expect(await search("to:team")).toEqual(["Lunch"]);
		expect(await search('subject:"weekly report"')).toEqual(["Weekly report"]);
	});

	test("flag operators", async () => {
		expect(await search("is:read")).toEqual(["Lunch"]);
		expect(await search("is:unread")).toEqual(["Weekly report", "Weekly sync"]);
		expect(await search("is:starred")).toEqual(["Weekly sync"]);
		expect(await search("is:unstarred from:bob")).toEqual(["Lunch"]);
	});

	test("dates: before is exclusive, after includes the day", async () => {
		expect(await search("before:2026-01-15")).toEqual(["Weekly report"]);
		expect(await search("after:2026-01-15")).toEqual(["Lunch", "Weekly sync"]);
		expect(await search("after:2026-01-11 before:2026-01-20")).toEqual(["Lunch"]);
	});

	test("an unknown operator is plain text, not an error", async () => {
		expect(await search("has:attachment")).toEqual([]);
	});
});
