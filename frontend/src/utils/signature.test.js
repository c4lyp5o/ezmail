import { marked } from "marked";
import { describe, expect, test } from "vitest";
import { markdownSafeSignature } from "./signature.js";

// Renders a signature the way a markdown-mode send does and returns the HTML
// of just the signature part (after the "-- " delimiter paragraph).
const render = (sig) => {
	const text = `Hi\n\n-- \n${sig}`;
	const md = markdownSafeSignature(text, sig);
	return marked.parse(md, { gfm: true, breaks: false }).split("<p>-- </p>")[1] ?? "";
};
const sigText = (sig) => render(sig).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

describe("markdownSafeSignature through marked", () => {
	test("bare URLs stay intact and link to what was typed", () => {
		const html = render("https://x.io/~ada/a_b_c");
		expect(html).toContain('href="https://x.io/~ada/a_b_c"');
		expect(html).not.toContain("%5C");
		expect(html).not.toContain("\\");
		expect(html).not.toContain("<del>");
		expect(html).not.toContain("<em>");
		expect(render("www.x.io/my_page")).toContain("www.x.io/my_page");
		expect(render("www.x.io/my_page")).not.toContain("\\");
		expect(render("www.x.io/my_page")).not.toContain("%5C");
	});

	test("email addresses, bare or in angle brackets, are plain and never a tag", () => {
		const html = render("Ada <ada@x.io>");
		expect(html).toContain("Ada");
		expect(html).toContain('href="mailto:ada@x.io"');
		expect(html).not.toContain("\\");
		expect(sigText("Ada <ada@x.io>")).toBe("Ada ada@x.io");
		expect(render("ada@x.io")).not.toContain("\\");
	});

	test("phone numbers and plain text are not escaped", () => {
		expect(render("+60 12-345")).toContain("+60 12-345");
		expect(render("+60 12-345")).not.toContain("\\");
		expect(sigText("snake_case_name")).toBe("snake_case_name");
		expect(render("snake_case_name")).not.toContain("<em>");
		expect(sigText("a * b")).toBe("a * b");
		expect(render("a * b")).not.toContain("<em>");
		expect(render("a * b")).not.toContain("<li>");
	});

	test("block markers at the start of a line are neutralised", () => {
		const dashes = render("Ada\n--");
		expect(dashes).not.toContain("<h2");
		expect(dashes).not.toContain("<hr");
		expect(sigText("--")).toBe("--");
		expect(render("# heading")).not.toContain("<h1");
		expect(sigText("# heading")).toBe("# heading");
		expect(render("1. item")).not.toContain("<ol");
		expect(sigText("1. item")).toBe("1. item");
		expect(render("- item")).not.toContain("<ul");
		expect(render("> quote")).not.toContain("<blockquote");
		const bold = render("*bold*");
		expect(bold).not.toContain("<em>");
		expect(bold).not.toContain("<li>");
		expect(sigText("*bold*")).toBe("*bold*");
	});

	test("markup can't inject links, images or HTML", () => {
		const link = render("[x](http://evil)");
		expect(link).not.toMatch(/<a [^>]*>x<\/a>/);
		expect(render("![x](http://evil/a.png)")).not.toContain("<img");
		const tag = render("<img src=x onerror=1>");
		expect(tag).not.toContain("<img");
		expect(sigText("<img src=x onerror=1>")).toBe("<img src=x onerror=1>");
		expect(render("www.x.io/<b>hi</b>")).not.toContain("<b>");
		expect(render("<script>alert(1)</script>")).not.toContain("<script");
	});
});
