import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { imap } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";
import { cleanSnippet, htmlToText, snippetFromPart } from "../services/snippet.js";

const b64 = (s, charset = "utf8") => Buffer.from(Buffer.from(s, charset).toString("base64"));

describe("snippetFromPart", () => {
	const long = "word ".repeat(60).trim();
	const cases = [
		["7bit plain text", Buffer.from("Hello there,\r\nsee you soon."), {}, "Hello there, see you soon."],
		["8bit utf-8", Buffer.from("Grüße aus Köln"), { encoding: "8bit", charset: "utf-8" }, "Grüße aus Köln"],
		["base64", b64("Hi Bob, lunch?"), { encoding: "base64" }, "Hi Bob, lunch?"],
		["base64 cut mid-unit", b64("Hi Bob, lunch?").subarray(0, 10), { encoding: "base64" }, "Hi Bob"],
		["base64 with line breaks", Buffer.from("SGkg\r\nQm9i"), { encoding: "base64" }, "Hi Bob"],
		["quoted-printable", Buffer.from("Caf=C3=A9 au lait=\r\n please"), { encoding: "quoted-printable", charset: "utf-8" }, "Café au lait please"],
		["quoted-printable cut after =", Buffer.from("Caf="), { encoding: "QUOTED-PRINTABLE" }, "Caf"],
		["quoted-printable cut mid-escape", Buffer.from("Caf=C"), { encoding: "quoted-printable" }, "Caf"],
		["quoted-printable cut mid-character", Buffer.from("Caf=C3"), { encoding: "quoted-printable", charset: "utf-8" }, "Caf"],
		["utf-8 cut mid-character", Buffer.from("naïve").subarray(0, 3), { charset: "utf-8" }, "na"],
		["base64 utf-8 cut mid-character", b64("日本語").subarray(0, 8), { encoding: "base64", charset: "utf-8" }, "日本"],
		["latin1 charset", Buffer.from("Gr\xfc\xdfe", "latin1"), { charset: "iso-8859-1" }, "Grüße"],
		["unknown charset falls back to utf-8", Buffer.from("Grüße"), { charset: "x-bogus" }, "Grüße"],
		["invalid utf-8 falls back to latin1", Buffer.from("Gr\xfc\xdfe", "latin1"), {}, "Grüße"],
		["koi8-r", Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]), { charset: "koi8-r" }, "Привет"],
		["quoted lines and lead-in dropped", Buffer.from("Sounds good.\r\n\r\nOn Mon, 1 Jan 2026, Bob wrote:\r\n> earlier\r\n> text"), {}, "Sounds good."],
		["signature dropped", Buffer.from("Thanks!\r\n-- \r\nBob\r\nACME"), {}, "Thanks!"],
		["long text trimmed with ellipsis", Buffer.from(long), {}, `${long.slice(0, 139).trimEnd()}…`],
		["html stripped", Buffer.from("<html><head><title>T</title><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>Bob</b> &amp; co</p><script>x()</script><p>Bye &#233;&#x263A;</p></body>"), { type: "text/html" }, "Hello Bob & co Bye é☺"],
		["html cut inside a tag", Buffer.from("<p>Hello</p><a href=\"http://x"), { type: "TEXT/HTML" }, "Hello"],
		["html cut inside style", Buffer.from("<style>body { color"), { type: "text/html" }, undefined],
		["html cut inside an entity", Buffer.from("<p>Tom &am"), { type: "text/html" }, "Tom"],
		["html blockquote dropped", Buffer.from("<p>Yes.</p><blockquote>old mail</blockquote>"), { type: "text/html" }, "Yes."],
		["bidi override stripped", Buffer.from("\u202Eevil \u2066x\u2069 text\u200F"), {}, "evil x text"],
		["control characters stripped", Buffer.from("a\u0000b\u0007c\u0085d\u007fe"), {}, "abcde"],
		["empty buffer", Buffer.alloc(0), {}, undefined],
		["whitespace only", Buffer.from(" \r\n\t "), {}, undefined],
	];
	for (const [name, buf, part, expected] of cases) {
		test(name, () => {
			expect(snippetFromPart(buf, part)).toBe(expected);
		});
	}

	test("trims on a code point boundary", () => {
		const emoji = "😀".repeat(200);
		const out = cleanSnippet(emoji);
		expect(Array.from(out)).toHaveLength(140);
		expect(out.endsWith("😀…")).toBe(true);
	});

	test("lone surrogates are stripped, valid pairs kept", () => {
		expect(cleanSnippet("hi \u{1F600} \uD800 there \uDC00")).toBe("hi \u{1F600}  there");
	});

	test("html extraction never leaves markup", () => {
		expect(htmlToText("<img src=x onerror=alert(1)>hi<!-- c -->")).not.toContain("<");
	});
});

const ME = "snippets@x.io";
let cookie;

beforeAll(async () => {
	imap.reset();
	imap.addBox("INBOX");
	cookie = await login(ME);
});

beforeEach(() => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
});

const list = (qs = "") => call("GET", `/api/v1/mail/messages/INBOX${qs}`, { cookie });
const snippetFetches = () => imap.calls.filter((c) => c.cmd === "fetch" && c.bodyParts);

// A text/plain message whose body is part 1 (single part).
const plain = (body, extra = {}) =>
	imap.addMessage("INBOX", {
		bodyStructure: { type: "text/plain", encoding: extra.encoding || "7bit", parameters: { charset: extra.charset || "utf-8" } },
		parts: { 1: Buffer.from(body) },
		rawParts: extra.raw ? { 1: extra.raw } : undefined,
	});

// multipart/alternative with text/plain at 1 and text/html at 2.
const alternative = (text) =>
	imap.addMessage("INBOX", {
		bodyStructure: {
			type: "multipart/alternative",
			childNodes: [
				{ part: "1", type: "text/plain", encoding: "quoted-printable", parameters: { charset: "utf-8" } },
				{ part: "2", type: "text/html", encoding: "7bit" },
			],
		},
		parts: { 1: Buffer.from(text), 2: Buffer.from(`<p>${text}</p>`) },
		rawParts: { 1: Buffer.from(text), 2: Buffer.from(`<p>${text}</p>`) },
	});

// multipart/mixed whose text/plain body sits after `skip` attachments.
const bodyAt = (skip, text) => {
	const childNodes = [];
	for (let i = 1; i <= skip; i++)
		childNodes.push({ part: String(i), type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: `${i}.pdf` } });
	childNodes.push({ part: String(skip + 1), type: "text/plain", encoding: "7bit" });
	return imap.addMessage("INBOX", {
		bodyStructure: { type: "multipart/mixed", childNodes },
		parts: { [skip + 1]: Buffer.from(text) },
	});
};

describe("message list snippets", () => {
	test("off by default: no snippet field and no extra fetch", async () => {
		plain("hello");
		imap.calls = [];
		const res = await list();
		expect(res.status).toBe(200);
		expect("snippet" in res.json.data.messages[0]).toBe(false);
		expect(imap.calls.filter((c) => c.cmd === "fetch")).toHaveLength(1);
		expect(snippetFetches()).toHaveLength(0);
	});

	test("one partial fetch per distinct part, never marking messages read", async () => {
		plain("first plain");
		plain("second plain");
		alternative("alt one");
		alternative("alt two");
		const htmlOnly = imap.addMessage("INBOX", {
			bodyStructure: { type: "text/html", encoding: "7bit" },
			parts: { 1: Buffer.from("<p>only <i>html</i></p>") },
		});
		imap.calls = [];
		const res = await list("?snippets=1");
		expect(res.status).toBe(200);
		const byUid = Object.fromEntries(res.json.data.messages.map((m) => [m.uid, m.snippet]));
		expect(byUid).toEqual({ 1: "first plain", 2: "second plain", 3: "alt one", 4: "alt two", [htmlOnly]: "only html" });
		// Parts "1" (plain, html-only, alternative's text/plain) — one group.
		expect(snippetFetches()).toHaveLength(1);
		const [f] = snippetFetches();
		expect(f.uid).toBe(true);
		expect(f.bodyParts).toEqual([{ key: "1", start: 0, maxLength: 512 }]);
		expect(res.json.data.messages.every((m) => m.seen === false)).toBe(true);
		expect(imap.boxes.get("INBOX").messages.every((m) => !m.flags.has("\\Seen"))).toBe(true);
	});

	test("fetch count follows distinct parts, not messages", async () => {
		for (let i = 0; i < 4; i++) plain(`p${i}`);
		for (let i = 0; i < 3; i++) bodyAt(1, `after one ${i}`);
		bodyAt(2, "after two");
		imap.calls = [];
		const res = await list("?snippets=1");
		expect(snippetFetches()).toHaveLength(3);
		expect(res.json.data.messages.every((m) => typeof m.snippet === "string")).toBe(true);
	});

	test("decodes base64 and quoted-printable bodies cut at 512 bytes", async () => {
		const text = "Ünïcödé ".repeat(100);
		plain(text, { encoding: "base64", raw: Buffer.from(Buffer.from(text).toString("base64").replace(/(.{76})/g, "$1\r\n")) });
		const qp = "Caf=C3=A9 ".repeat(60);
		plain("", { encoding: "quoted-printable", raw: Buffer.from(qp.slice(0, 515)) });
		const res = await list("?snippets=1&sort=asc");
		const [a, b] = res.json.data.messages;
		expect(a.snippet.startsWith("Ünïcödé Ünïcödé")).toBe(true);
		expect(a.snippet).not.toContain("�");
		expect(Array.from(a.snippet)).toHaveLength(140);
		expect(b.snippet.startsWith("Café Café")).toBe(true);
		expect(b.snippet).not.toContain("�");
	});

	test("caps the number of part groups", async () => {
		for (let skip = 0; skip < 8; skip++) bodyAt(skip, `body ${skip}`);
		imap.calls = [];
		const res = await list("?snippets=1");
		expect(res.status).toBe(200);
		expect(snippetFetches()).toHaveLength(6);
		const withSnippet = res.json.data.messages.filter((m) => m.snippet);
		expect(withSnippet).toHaveLength(6);
	});

	test("a failing snippet fetch still returns the list", async () => {
		plain("hello");
		plain("world");
		imap.failBodyParts = true;
		const res = await list("?snippets=1");
		expect(res.status).toBe(200);
		expect(res.json.data.messages).toHaveLength(2);
		expect(res.json.data.messages.every((m) => m.snippet === undefined)).toBe(true);
	});

	test("messages without a text part get no snippet", async () => {
		imap.addMessage("INBOX", {
			bodyStructure: { type: "application/pkcs7-mime", disposition: "attachment", dispositionParameters: { filename: "smime.p7m" } },
			parts: { 1: Buffer.from("xx") },
		});
		imap.calls = [];
		const res = await list("?snippets=1");
		expect(res.json.data.messages[0].snippet).toBeUndefined();
		expect(snippetFetches()).toHaveLength(0);
	});

	test("search results get snippets too, and paging is unchanged", async () => {
		imap.addMessage("INBOX", { subject: "invoice", bodyStructure: { type: "text/plain" }, parts: { 1: Buffer.from("pay me") } });
		imap.addMessage("INBOX", { subject: "other" });
		const res = await list("?search=invoice&snippets=1&page=1&pageSize=10");
		expect(res.json.data.total).toBe(1);
		expect(res.json.data.pageSize).toBe(10);
		expect(res.json.data.messages[0].snippet).toBe("pay me");
	});
});
