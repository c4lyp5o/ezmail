// Builds ComposeView's starting state for reply / reply-all / forward from a
// fully loaded message (MessageView's data, incl. `addresses`).

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

export function buildDraft(mode, msg, me) {
	const when = msg.date ? new Date(msg.date).toLocaleString() : "";
	const text = bodyText(msg).trim();

	if (mode === "forward") {
		return {
			title: "Forward",
			form: {
				to: "",
				cc: "",
				subject: withPrefix("Fwd", msg.subject),
				text: `\n\n---------- Forwarded message ----------\nFrom: ${msg.from}\nDate: ${when}\nSubject: ${msg.subject}\nTo: ${msg.to}\n\n${text}`,
				markdown: false,
			},
			attachments: (msg.attachments || [])
				.filter((a) => a.content)
				.map(({ filename, contentType, content }) => ({
					filename,
					contentType,
					content,
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
		form: {
			to: to.join(", "),
			cc: cc.join(", "),
			subject: withPrefix("Re", msg.subject),
			text: `\n\nOn ${when}, ${msg.from} wrote:\n${text
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n")}`,
			markdown: false,
		},
		meta: {
			inReplyTo: msg.messageId,
			references: [msg.references, msg.messageId].filter(Boolean).join(" "),
		},
	};
}
