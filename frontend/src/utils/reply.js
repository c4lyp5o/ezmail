// Builds ComposeView's starting state for reply / reply-all / forward from a
// fully loaded message (MessageView's data, incl. `addresses`).
import { addSignature } from "./signature.js";

// "Re: x" stays "Re: x"; "Fw: x" / "Fwd: x" stay as-is when forwarding.
const withPrefix = (prefix, subject = "") =>
	(prefix === "Re" ? /^re:/i : /^fwd?:/i).test(subject)
		? subject
		: `${prefix}: ${subject}`;

function bodyText(msg) {
	if (msg.text) return msg.text;
	if (!msg.html) return "";
	return new DOMParser().parseFromString(msg.html, "text/html").body.textContent || "";
}

// `signature` (optional) goes above the quoted text; when it is passed the
// draft carries it, so ComposeView doesn't add it a second time.
export function buildDraft(mode, msg, me, signature) {
	const signed = signature !== undefined ? { signature } : {};
	const sign = (body) => (signature !== undefined ? addSignature(body, signature) : body);
	const when = msg.date ? new Date(msg.date).toLocaleString() : "";
	const text = bodyText(msg).trim();

	if (mode === "forward") {
		return {
			title: "Forward",
			...signed,
			form: {
				to: "",
				cc: "",
				subject: withPrefix("Fwd", msg.subject),
				text: sign(`\n\n---------- Forwarded message ----------\nFrom: ${msg.from}\nDate: ${when}\nSubject: ${msg.subject}\nTo: ${msg.to}\n\n${text}`),
				markdown: false,
			},
			// References, not bytes: the server copies them from the original.
			attachments: (msg.attachments || [])
				.filter((a) => !a.related)
				.map(({ filename, contentType, size, index }) => ({
					filename,
					contentType,
					size,
					forward: { folder: msg.folder, uid: msg.uid, index },
				})),
		};
	}

	const a = msg.addresses || { from: [], replyTo: [], to: [], cc: [] };
	const to = a.replyTo.length ? a.replyTo : a.from;
	// Reply-all: everyone on To/Cc except me and whoever is already in To.
	const seen = new Set([me, ...to].filter(Boolean).map((x) => x.toLowerCase()));
	const cc =
		mode === "replyAll"
			? [...a.to, ...a.cc].filter((x) => {
					const k = x.toLowerCase();
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				})
			: [];

	return {
		title: mode === "replyAll" ? "Reply all" : "Reply",
		...signed,
		form: {
			to: to.join(", "),
			cc: cc.join(", "),
			subject: withPrefix("Re", msg.subject),
			text: sign(`\n\nOn ${when}, ${msg.from} wrote:\n${text
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n")}`),
			markdown: false,
		},
		meta: {
			inReplyTo: msg.messageId,
			references: [msg.references, msg.messageId].filter(Boolean).join(" "),
		},
	};
}

// Block-aware HTML to text for resuming a draft: paragraphs, lines and <br>
// keep their breaks, table cells are tab-separated and <pre> stays verbatim
// (replies keep bodyText's plain textContent). Parsed into a detached
// document, never the live page.
const PARAGRAPH = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "UL", "OL", "TABLE", "HR"]);
const LINE = new Set(["DIV", "LI", "TR", "DD", "DT", "ADDRESS", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE"]);
export function htmlToText(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	let out = "";
	const walk = (node, pre) => {
		for (const child of node.childNodes) {
			if (child.nodeType === 3) out += pre ? child.nodeValue : child.nodeValue.replace(/\s+/g, " ");
			if (child.nodeType !== 1 || ["SCRIPT", "STYLE", "TEMPLATE"].includes(child.tagName)) continue;
			if (child.tagName === "BR") {
				out += "\n";
				continue;
			}
			// Block boundaries need at least this many line breaks; they don't stack.
			const gap = PARAGRAPH.has(child.tagName) ? 2 : LINE.has(child.tagName) ? 1 : 0;
			const breakTo = () => {
				const have = out.length - out.replace(/\n*$/, "").length;
				if (gap > have) out += "\n".repeat(gap - have);
			};
			breakTo();
			const cell = (el) => el?.tagName === "TD" || el?.tagName === "TH";
			if (cell(child) && cell(child.previousElementSibling)) out += "\t";
			// Outermost <pre> content is fenced off from the line clean-up below.
			const fence = child.tagName === "PRE" && !pre;
			if (fence) out += "\uE000";
			walk(child, pre || child.tagName === "PRE");
			if (fence) out += "\uE001";
			breakTo();
		}
	};
	walk(doc.body, false);
	// Outside <pre>: trim each line (keeping the "-- " signature delimiter
	// exact) and allow at most one blank line in a row.
	const tidy = (text) =>
		text
			.split("\n")
			.map((l) => (l.trim() === "--" ? "-- " : l.trim().replace(/ *\t */g, "\t")))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");
	return out
		.split(/\uE000([\s\S]*?)\uE001/)
		.map((part, i) => (i % 2 ? part : tidy(part)))
		.join("")
		.replace(/^\n+|\n+$/g, "");
}

// Starting state for continuing a server draft (a \Draft message in Drafts):
// no quoting, no new signature (the body has it), plain-text mode, and its
// attachments as forwarded references so the server copies them again.
export function resumeDraft(msg, folder) {
	return {
		title: "Edit draft",
		signature: "",
		draftUid: Number(msg.uid),
		fromServer: true,
		form: {
			to: msg.to || "",
			cc: msg.cc || "",
			bcc: msg.bcc || "",
			subject: msg.subject || "",
			text: msg.text || (msg.html ? htmlToText(msg.html) : ""),
			markdown: false,
		},
		meta: {
			...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
			...(msg.references ? { references: msg.references } : {}),
		},
		attachments: (msg.attachments || [])
			.filter((a) => !a.related)
			.map(({ filename, contentType, size, index }) => ({
				filename,
				contentType,
				size,
				forward: { folder, uid: Number(msg.uid), index },
			})),
	};
}
