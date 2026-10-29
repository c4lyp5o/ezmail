import { beforeEach, describe, expect, test } from "bun:test";
import MailComposer from "nodemailer/lib/mail-composer";
import { imap } from "./helpers/fake-imap.js";
import { smtp } from "./helpers/fake-smtp.js";
import { call, login } from "./helpers/http.js";

const PDF = Buffer.from("%PDF-1.4 fake pdf bytes");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let cookie;
let uid;
// mailparser's order (inline/related parts first) defines the indexes.
let pdfIndex;
let logoIndex;

const get = (path) => call("GET", `/api/v1/mail${path}`, { cookie });

beforeEach(async () => {
	imap.reset();
	smtp.reset();
	imap.addBox("INBOX", "\\Inbox");
	imap.addBox("Sent", "\\Sent");
	cookie ??= await login("att@x.io");
	const raw = await new MailComposer({
		from: "bob@x.io",
		to: "att@x.io",
		subject: "files",
		html: '<p>logo: <img src="cid:logo@x"></p>',
		attachments: [
			{ filename: "report ü.pdf", content: PDF, contentType: "application/pdf" },
			{ filename: "logo.png", content: PNG, contentType: "image/png", cid: "logo@x" },
		],
	})
		.compile()
		.build();
	uid = imap.addMessage("INBOX", {
		source: raw.toString(),
		bodyStructure: { type: "multipart/mixed", childNodes: [
			{ type: "multipart/related", childNodes: [
				{ part: "1.1", type: "text/html" },
				{ part: "1.2", type: "image/png", disposition: "inline", dispositionParameters: { filename: "logo.png" }, id: "<logo@x>", size: PNG.length },
			] },
			{ part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "report ü.pdf" }, size: PDF.length },
		] },
		parts: { "1.1": Buffer.from('<p>logo: <img src="cid:logo@x"></p>'), "1.2": PNG, "2": PDF },
	});
	const atts = (await get(`/message/INBOX/${uid}`)).json.data.attachments;
	pdfIndex = atts.find((a) => a.filename === "report ü.pdf").index;
	logoIndex = atts.find((a) => a.filename === "logo.png").index;
});


async function getRaw(path) {
	const { app } = await import("../index.js");
	return app.handle(
		new Request(`http://localhost/api/v1/mail${path}`, { headers: { cookie } }),
	);
}

describe("message payload", () => {
	test("lists attachment metadata without the bytes", async () => {
		imap.calls = [];
		const res = await get(`/message/INBOX/${uid}`);
		const atts = res.json.data.attachments;
		expect(atts.map((a) => a.index)).toEqual([0, 1]);
		expect(atts[pdfIndex]).toMatchObject({
			filename: "report ü.pdf",
			related: false,
			size: PDF.length,
		});
		expect(atts[logoIndex]).toMatchObject({ filename: "logo.png", related: true });
		expect(JSON.stringify(res.json)).not.toContain(PDF.toString("base64"));
		expect(imap.calls.some((call) => call.query?.source)).toBe(false);
		expect(imap.calls).toContainEqual({ cmd: "downloadBody", uid: true, part: "1.1" });
	});

	test("cid: images point at the attachment endpoint, not inline base64", async () => {
		const { html } = (await get(`/message/INBOX/${uid}`)).json.data;
		expect(html).toContain(`src="/api/v1/mail/message/INBOX/${uid}/attachment/${logoIndex}"`);
		expect(html).not.toContain("data:image");
	});

	test("large text bodies are rejected without fetching attachment data", async () => {
		const msg = imap.boxes.get("INBOX").messages.find((m) => m.uid === uid);
		msg.parts["1.1"] = Buffer.alloc(8 * 1024 * 1024 + 1, 65);
		imap.calls = [];
		const response = await get(`/message/INBOX/${uid}`);
		expect(response.status).toBe(502);
		expect(imap.calls.some((call) => call.cmd === "download")).toBe(false);
	});
});

describe("attachment endpoint", () => {
	test("serves the bytes as a sandboxed download", async () => {
		imap.calls = [];
		const res = await getRaw(`/message/INBOX/${uid}/attachment/${pdfIndex}`);
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="report _.pdf"; filename*=UTF-8''report%20%C3%BC.pdf`,
		);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(imap.calls).toContainEqual({ cmd: "download", uid: true, part: "2" });
		expect(imap.calls.some((call) => call.query?.source)).toBe(false);
	});

	test("unknown index → 404, no session → 401", async () => {
		expect((await get(`/message/INBOX/${uid}/attachment/9`)).status).toBe(404);
		const anon = await call("GET", `/api/v1/mail/message/INBOX/${uid}/attachment/0`);
		expect(anon.status).toBe(401);
	});

	test("inline and regular attachments retain distinct part identities", async () => {
		const image = await getRaw(`/message/INBOX/${uid}/attachment/${logoIndex}`);
		expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
		const pdf = await getRaw(`/message/INBOX/${uid}/attachment/${pdfIndex}`);
		expect(Buffer.from(await pdf.arrayBuffer())).toEqual(PDF);
	});
});

describe("forwarding", () => {
	test("attachments are copied from the original server-side", async () => {
		imap.calls = [];
		const res = await call("POST", "/api/v1/mail/send", {
			cookie,
			body: {
				to: "carol@x.io",
				subject: "Fwd: files",
				text: "see attached",
				forwardAttachments: { folder: "INBOX", uid, indexes: [pdfIndex] },
			},
		});
		expect(res.status).toBe(200);
		const [att] = smtp.sent[0].mail.attachments;
		expect(att.filename).toBe("report ü.pdf");
		expect(Buffer.from(att.content)).toEqual(PDF);
		expect(imap.calls).toContainEqual({ cmd: "download", uid: true, part: "2" });
		expect(imap.calls.some((call) => call.query?.source)).toBe(false);
	});

	test("a bad index is a 400 and nothing is sent", async () => {
		const res = await call("POST", "/api/v1/mail/send", {
			cookie,
			body: {
				to: "carol@x.io",
				forwardAttachments: { folder: "INBOX", uid, indexes: [7] },
			},
		});
		expect(res.status).toBe(400);
		expect(smtp.sent).toHaveLength(0);
	});
});
