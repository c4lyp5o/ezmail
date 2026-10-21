import { describe, expect, test } from "vitest";
import { emailCsp, emailDoc } from "./MessageView.jsx";

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
