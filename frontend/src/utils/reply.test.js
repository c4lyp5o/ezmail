import { describe, expect, test } from "vitest";
import { buildDraft, resumeDraft } from "./reply.js";
import { addSignature, markdownSafeSignature, signatureBlock } from "./signature.js";

const msg = {
	subject: "Lunch?",
	from: "Bob <bob@x.io>",
	to: "me@x.io, carol@x.io",
	date: "2026-10-20T10:00:00Z",
	text: "line1\nline2",
	messageId: "<m2@x.io>",
	references: "<m1@x.io>",
	addresses: {
		from: ["bob@x.io"],
		replyTo: [],
		to: ["ME@x.io", "carol@x.io"],
		cc: ["bob@x.io", "dan@x.io"],
	},
	folder: "INBOX",
	uid: 42,
	attachments: [
		{ index: 0, filename: "logo.png", contentType: "image/png", size: 9, related: true },
		{ index: 1, filename: "a.pdf", contentType: "application/pdf", size: 1, related: false },
	],
};

describe("reply", () => {
	test("goes to the sender, quotes the body, threads", () => {
		const d = buildDraft("reply", msg, "me@x.io");
		expect(d.title).toBe("Reply");
		expect(d.form.to).toBe("bob@x.io");
		expect(d.form.cc).toBe("");
		expect(d.form.subject).toBe("Re: Lunch?");
		expect(d.form.text).toMatch(/Bob <bob@x\.io> wrote:\n> line1\n> line2$/);
		expect(d.meta).toEqual({
			inReplyTo: "<m2@x.io>",
			references: "<m1@x.io> <m2@x.io>",
		});
	});

	test("prefers Reply-To", () => {
		const d = buildDraft(
			"reply",
			{ ...msg, addresses: { ...msg.addresses, replyTo: ["list@x.io"] } },
			"me@x.io",
		);
		expect(d.form.to).toBe("list@x.io");
	});

	test("doesn't stack Re: prefixes", () => {
		expect(buildDraft("reply", { ...msg, subject: "RE: Lunch?" }).form.subject).toBe(
			"RE: Lunch?",
		);
	});

	test("reply-all drops me (any case) and duplicates", () => {
		const d = buildDraft("replyAll", msg, "me@x.io");
		expect(d.form.to).toBe("bob@x.io");
		expect(d.form.cc).toBe("carol@x.io, dan@x.io");
	});
});

describe("forward", () => {
	test("references real attachments (not inline images), no threading", () => {
		const d = buildDraft("forward", { ...msg, subject: "Fw: Lunch?" }, "me@x.io");
		expect(d.form.subject).toBe("Fw: Lunch?");
		expect(d.form.to).toBe("");
		expect(d.attachments).toEqual([
			{
				filename: "a.pdf",
				contentType: "application/pdf",
				size: 1,
				forward: { folder: "INBOX", uid: 42, index: 1 },
			},
		]);
		expect(d.meta).toBeUndefined();
		expect(d.form.text).toContain("---------- Forwarded message ----------");
	});

	test("HTML-only mail is quoted as text", () => {
		const d = buildDraft("forward", { ...msg, text: "", html: "<p>hello <b>there</b></p>" });
		expect(d.form.text).toMatch(/hello there$/);
	});
});

describe("signature", () => {
	const SIG = "Ada\nAnalyst";
	test("new message: the body is the signature block", () => {
		expect(addSignature("", SIG)).toBe("\n\n-- \nAda\nAnalyst");
	});

	test("reply and forward: signature above the quoted text, typing starts above it", () => {
		const r = buildDraft("reply", msg, "me@x.io", SIG);
		expect(r.form.text).toMatch(/^\n\n-- \nAda\nAnalyst\n\nOn .*, Bob <bob@x\.io> wrote:\n> line1\n> line2$/);
		expect(r.signature).toBe(SIG);
		const f = buildDraft("forward", msg, "me@x.io", SIG);
		expect(f.form.text).toMatch(/^\n\n-- \nAda\nAnalyst\n\n---------- Forwarded message ----------\n/);
	});

	test("empty or missing signature adds nothing", () => {
		expect(addSignature("x", "")).toBe("x");
		expect(addSignature("x", "  \n ")).toBe("x");
		expect(buildDraft("reply", msg, "me@x.io", "").form.text).toBe(buildDraft("reply", msg, "me@x.io").form.text);
		expect(buildDraft("reply", msg, "me@x.io")).not.toHaveProperty("signature");
	});

	test("markdown: an unedited signature is escaped, keeps line breaks and its own paragraph", () => {
		const sig = "**Ada** <script>x</script>\n> quote\n- item\n2. two\n[a](b)";
		const text = `Hi${signatureBlock(sig)}\n\n> quoted`;
		expect(markdownSafeSignature(text, sig)).toBe(
			"Hi\n\n-- \n\n\\*\\*Ada\\*\\* \\<script\\>x\\</script\\>  \n\\> quote  \n\\- item  \n2\\. two  \n\\[a\\](b)\n\n> quoted",
		);
	});

	test("markdown: an edited or missing signature is left to the user", () => {
		expect(markdownSafeSignature("Hi\n\n-- \nAda (edited)", "Ada\nAnalyst")).toBe("Hi\n\n-- \nAda (edited)");
		expect(markdownSafeSignature("*hi*", "")).toBe("*hi*");
	});
});

describe("resume draft", () => {
	test("keeps fields as stored, no prefix or quoting, attachments as references", () => {
		const d = resumeDraft({ ...msg, subject: "Lunch?", cc: "dan@x.io", bcc: "hid@x.io", inReplyTo: "<m1@x.io>", uid: "42" }, "Drafts");
		expect(d).toMatchObject({
			title: "Edit draft",
			signature: "",
			draftUid: 42,
			form: { to: "me@x.io, carol@x.io", cc: "dan@x.io", bcc: "hid@x.io", subject: "Lunch?", text: "line1\nline2", markdown: false },
			meta: { inReplyTo: "<m1@x.io>", references: "<m1@x.io>" },
		});
		expect(d.attachments).toEqual([
			{ filename: "a.pdf", contentType: "application/pdf", size: 1, forward: { folder: "Drafts", uid: 42, index: 1 } },
		]);
	});

	test("an html-only draft becomes plain text", () => {
		const d = resumeDraft({ uid: 3, html: "<p>Hi <b>there</b></p>", attachments: [] }, "Drafts");
		expect(d.form).toMatchObject({ to: "", subject: "", text: "Hi there" });
		expect(d.meta).toEqual({});
	});

	test("an html-only draft keeps its line breaks and paragraphs", () => {
		const html = "<div>Hi Bob,</div><div><br></div><p>Line one<br>line\n  two</p><p></p><p></p><ul><li>a</li><li>b</li></ul><div>-- <br>Ada</div><script>x()</script>";
		const d = resumeDraft({ uid: 3, html, attachments: [] }, "Drafts");
		expect(d.form.text).toBe("Hi Bob,\n\nLine one\nline two\n\na\nb\n\n-- \nAda");
	});

	test("pre keeps its indentation and blank lines; table cells are tab-separated", () => {
		const html = "<p>Code:</p><pre>  if (x) {\n\n\n    y();\n  }</pre><table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td> 1 </td></tr></table>";
		const d = resumeDraft({ uid: 3, html, attachments: [] }, "Drafts");
		expect(d.form.text).toBe("Code:\n\n  if (x) {\n\n\n    y();\n  }\n\nName\tValue\na\t1");
	});

	test("replies still quote html with plain textContent", () => {
		const d = buildDraft("reply", { ...msg, text: "", html: "<p>a</p><p>b</p>" }, "me@x.io");
		expect(d.form.text).toContain("> ab");
	});
});
