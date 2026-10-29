import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
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
});
