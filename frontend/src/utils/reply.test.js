import { describe, expect, test } from "vitest";
import { buildDraft } from "./reply.js";

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
