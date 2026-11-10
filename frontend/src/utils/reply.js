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
