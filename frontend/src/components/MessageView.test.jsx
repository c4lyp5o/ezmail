import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import { isPreviewable } from "./ImagePreview.jsx";
import MessageView, { emailCsp, emailDoc } from "./MessageView.jsx";

const parse = (doc) => new DOMParser().parseFromString(doc, "text/html");
const HTML = `
	<p style="background:url(https://t.example/bg.gif)">hi</p>
	<img id="remote" src="https://t.example/pixel.gif" srcset="https://t.example/2x.gif 2x">
	<img id="inline" src="/api/v1/mail/message/INBOX/1/attachment/0">
	<a id="link" href="https://example.com">x</a>`;

describe("remote content blocking", () => {
	test("CSP allows only own-origin/data images until opted in", () => {
		const csp = emailCsp(false);
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("img-src 'self' data:;");
		expect(csp).not.toMatch(/https?:/);
		expect(emailCsp(true)).toContain("img-src 'self' data: https: http:");
	});

	test("the policy is embedded in the frame document", () => {
		const meta = parse(emailDoc(HTML, false)).querySelector(
			'meta[http-equiv="Content-Security-Policy"]',
		);
		expect(meta.getAttribute("content")).toBe(emailCsp(false));
	});

	test("remote <img> URLs are parked until opted in; inline ones stay", () => {
		const blocked = parse(emailDoc(HTML, false));
		const img = blocked.getElementById("remote");
		expect(img.hasAttribute("src")).toBe(false);
		expect(img.hasAttribute("srcset")).toBe(false);
		expect(img.getAttribute("data-remote-src")).toBe("https://t.example/pixel.gif");
		expect(blocked.getElementById("inline").getAttribute("src")).toContain(
			"/attachment/0",
		);

		const shown = parse(emailDoc(HTML, true));
		expect(shown.getElementById("remote").getAttribute("src")).toBe(
			"https://t.example/pixel.gif",
		);
	});

	test("links open in a new tab without referrer", () => {
		const a = parse(emailDoc(HTML, false)).getElementById("link");
		expect(a.target).toBe("_blank");
		expect(a.rel).toBe("noopener noreferrer");
	});
});

describe("reader", () => {
	const MSG = {
		uid: 5,
		folder: "INBOX",
		subject: "Re: Plan",
		from: "bob@x.io",
		fromName: "Bob",
		to: "me@x.io",
		date: "2026-10-03T10:00:00Z",
		flags: ["\\Seen"],
		html: "",
		text: "see below",
		messageId: "<c3@x>",
		attachments: [
			{ index: 0, filename: "logo.png", contentType: "image/png", size: 5, related: true },
			{ index: 1, filename: "plan.pdf", contentType: "application/pdf", size: 2048, related: false },
		],
	};
	const THREAD = [
		{ folder: "INBOX", uid: 1, subject: "Plan", from: "bob@x.io", fromName: "Bob", date: "2026-10-01T10:00:00Z", seen: true },
		{ folder: "Sent", uid: 3, subject: "Re: Plan", from: "me@x.io", fromName: "", date: "2026-10-02T10:00:00Z", seen: true },
		{ folder: "INBOX", uid: 5, subject: "Re: Plan", from: "bob@x.io", fromName: "Bob", date: "2026-10-03T10:00:00Z", seen: true },
	];
	const view = (props) =>
		render(
			<MessageView
				folder="INBOX"
				uid={5}
				onBack={() => {}}
				onDelete={async () => {}}
				setShowRemote={() => {}}
				showRemote={false}
				{...props}
			/>,
		);

	test("an older response cannot replace the newly selected message", async () => {
		let finishOld;
		const oldResponse = new Promise((resolve) => { finishOld = resolve; });
		vi.stubGlobal("fetch", vi.fn((url) => {
			if (String(url).endsWith("/INBOX/1")) return oldResponse;
			return Promise.resolve(new Response(JSON.stringify({ success: true, data: { ...MSG, uid: 2, messageId: undefined, subject: "New message" } }), { headers: { "content-type": "application/json" } }));
		}));
		const onLoaded = vi.fn();
		const setShowRemote = vi.fn();
		const props = { folder: "INBOX", onLoaded, setShowRemote, showRemote: false };
		const { rerender } = render(<MessageView {...props} uid={1} />);
		rerender(<MessageView {...props} uid={2} />);
		await screen.findByText("New message");
		await act(async () => finishOld(new Response(JSON.stringify({ success: true, data: { ...MSG, uid: 1, subject: "Old message" } }), { headers: { "content-type": "application/json" } })));
		expect(screen.queryByText("Old message")).toBeNull();
		expect(onLoaded).toHaveBeenCalledTimes(1);
	});

	test("lists the conversation and opens another message from it", async () => {
		mockApi({
			"GET /mail/message/INBOX/5": MSG,
			"GET /mail/message/INBOX/5/thread": THREAD,
		});
		const onOpenThread = vi.fn();
		view({ onOpenThread });
		fireEvent.click(await screen.findByText(/Conversation · 3 messages/));
		const items = screen.getAllByRole("listitem");
		expect(items).toHaveLength(3);
		expect(items[2].querySelector("button").disabled).toBe(true); // current
		fireEvent.click(screen.getByText("me@x.io", { selector: "span" }));
		expect(onOpenThread).toHaveBeenCalledWith("Sent", 3);
	});

	test("no conversation box for a lone message", async () => {
		mockApi({
			"GET /mail/message/INBOX/5": MSG,
			"GET /mail/message/INBOX/5/thread": [THREAD[2]],
		});
		view();
		await screen.findByText("see below");
		expect(screen.queryByText(/Conversation/)).toBeNull();
	});

	test("file attachments are download links; inline images aren't listed", async () => {
		mockApi({ "GET /mail/message/INBOX/5": MSG, "GET /mail/message/INBOX/5/thread": [] });
		view();
		const link = (await screen.findByText("plan.pdf")).closest("a");
		expect(link.getAttribute("href")).toBe("/api/v1/mail/message/INBOX/5/attachment/1");
		expect(link.getAttribute("download")).toBe("plan.pdf");
		expect(screen.queryByText("logo.png")).toBeNull();
	});

	test("markdown-looking plain text renders in the gated frame, not the page", async () => {
		const text = "- hi\n\n![x](https://tracker.example/p.gif)\n\n[site](https://example.com)";
		mockApi({
			"GET /mail/message/INBOX/5": { ...MSG, text, attachments: [] },
			"GET /mail/message/INBOX/5/thread": [],
		});
		const setShowRemote = vi.fn();
		const { container, rerender } = view({ setShowRemote });
		const frame = await screen.findByTitle("email-body");
		expect(frame.getAttribute("sandbox")).toBe("allow-same-origin allow-popups allow-popups-to-escape-sandbox");
		expect(container.querySelector('img[src^="https:"]')).toBeNull();
		const doc = parse(frame.getAttribute("srcdoc"));
		expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toBe(emailCsp(false));
		const img = doc.querySelector("img");
		expect(img.hasAttribute("src")).toBe(false);
		expect(img.getAttribute("data-remote-src")).toBe("https://tracker.example/p.gif");
		const a = doc.querySelector("a");
		expect(a.target).toBe("_blank");
		expect(a.rel).toBe("noopener noreferrer");

		fireEvent.click(screen.getByText("Load remote images"));
		expect(setShowRemote).toHaveBeenCalledWith(true);
		rerender(<MessageView folder="INBOX" uid={5} onBack={() => {}} onDelete={async () => {}} setShowRemote={setShowRemote} showRemote />);
		const shown = parse(screen.getByTitle("email-body").getAttribute("srcdoc"));
		expect(shown.querySelector("img").getAttribute("src")).toBe("https://tracker.example/p.gif");
	});

	test("ordinary plain text stays a <pre> with no frame or remote button", async () => {
		mockApi({ "GET /mail/message/INBOX/5": { ...MSG, attachments: [] }, "GET /mail/message/INBOX/5/thread": [] });
		view();
		const pre = await screen.findByText("see below");
		expect(pre.tagName).toBe("PRE");
		expect(screen.queryByTitle("email-body")).toBeNull();
		expect(screen.queryByText("Load remote images")).toBeNull();
	});

	test("HTML mail still renders its own HTML in the frame", async () => {
		mockApi({ "GET /mail/message/INBOX/5": { ...MSG, html: HTML, text: "- fallback", attachments: [] }, "GET /mail/message/INBOX/5/thread": [] });
		view();
		const frame = await screen.findByTitle("email-body");
		expect(frame.getAttribute("srcdoc")).toBe(emailDoc(HTML, false));
		expect(screen.getByText("Load remote images")).toBeTruthy();
	});
});

describe("image attachment previews", () => {
	const att = (index, filename, contentType) => ({ index, filename, contentType, size: 10, related: false });
	const MSG = {
		uid: 7,
		folder: "My Box",
		subject: "Pics",
		from: "ann@x.io",
		to: "me@x.io",
		date: "2026-10-03T10:00:00Z",
		flags: ["\\Seen"],
		html: "",
		text: "pics attached",
		attachments: [
			att(0, "a.png", "IMAGE/PNG; name=a.png"),
			att(1, "b.svg", "image/svg+xml"),
			att(2, "c.pdf", "application/pdf"),
			att(3, "d.png", "image/pngx"),
			att(4, "e.webp", "image/webp"),
			att(5, "f.html", "text/html"),
		],
	};
	const base = "/api/v1/mail/message/My%20Box/7/attachment";
	const setup = async () => {
		mockApi({ "GET /mail/message/My%20Box/7": MSG, "GET /mail/message/My%20Box/7/thread": [] });
		render(<MessageView folder="My Box" uid={7} onBack={() => {}} onDelete={async () => {}} setShowRemote={() => {}} showRemote={false} />);
		await screen.findByText("pics attached");
	};

	test("isPreviewable is an exact allowlist on the normalised type", () => {
		for (const t of ["image/png", "IMAGE/PNG; name=x", "image/jpeg", " image/gif ", "image/webp;q=1"]) expect(isPreviewable(t)).toBe(true);
		for (const t of ["image/svg+xml", "image/pngx", "text/html", "application/pdf", "image/jpg", "image/*", "", undefined, "xx image/png"]) expect(isPreviewable(t)).toBe(false);
	});

	test("only allowlisted types get a preview; others stay plain downloads", async () => {
		await setup();
		expect(screen.getAllByRole("button", { name: /^Preview / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Preview a.png", "Preview e.webp"]);
		for (const [i, name] of [[1, "b.svg"], [2, "c.pdf"], [3, "d.png"], [5, "f.html"]]) {
			const link = screen.getByText(name).closest("a");
			expect(link.getAttribute("href")).toBe(`${base}/${i}`);
			expect(link.getAttribute("download")).toBe(name);
		}
		// Previewable ones keep a direct download link without opening the preview.
		const dl = screen.getByRole("link", { name: "Download a.png" });
		expect(dl.getAttribute("href")).toBe(`${base}/0`);
		expect(dl.getAttribute("download")).toBe("a.png");
	});

	test("the lightbox shows the inline URL, downloads the normal one, and Escape restores focus", async () => {
		await setup();
		const chip = screen.getByRole("button", { name: "Preview a.png" });
		chip.focus();
		fireEvent.click(chip);
		const dialog = await screen.findByRole("dialog", { name: "Preview of a.png" });
		const img = dialog.querySelector("img");
		expect(img.getAttribute("src")).toBe(`${base}/0?inline=1`);
		expect(img.getAttribute("alt")).toBe("a.png");
		expect(img.className).toContain("object-contain");
		expect(dialog.querySelectorAll("iframe, object, embed")).toHaveLength(0);
		expect(within(dialog).getByRole("status", { name: "Loading image" })).toBeTruthy();
		fireEvent.load(img);
		expect(within(dialog).queryByRole("status")).toBeNull();
		const dl = within(dialog).getByRole("link", { name: /Download/ });
		expect(dl.getAttribute("href")).toBe(`${base}/0`);
		expect(dl.getAttribute("download")).toBe("a.png");
		expect(dialog.contains(document.activeElement)).toBe(true);
		fireEvent.keyDown(document.activeElement, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(chip);
	});

	test("pages between previewable images and closes on the backdrop", async () => {
		await setup();
		fireEvent.click(screen.getByRole("button", { name: "Preview a.png" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(screen.getByRole("dialog", { name: "Preview of e.webp" }).querySelector("img").getAttribute("src")).toBe(`${base}/4?inline=1`);
		fireEvent.click(screen.getByRole("button", { name: "Next image" }));
		expect(screen.getByRole("dialog", { name: "Preview of a.png" })).toBeTruthy();
		fireEvent.click(screen.getByRole("dialog").parentElement);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("a failed image offers the download instead", async () => {
		await setup();
		fireEvent.click(screen.getByRole("button", { name: "Preview e.webp" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.error(dialog.querySelector("img"));
		const alert = within(dialog).getByRole("alert");
		expect(alert.textContent).toContain("couldn't be shown");
		expect(within(alert).getByRole("link", { name: /Download instead/ }).getAttribute("href")).toBe(`${base}/4`);
		fireEvent.click(within(dialog).getByRole("button", { name: "Close preview" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
