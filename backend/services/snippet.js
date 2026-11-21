// Preview text for the message list, built from the first bytes of a body
// part (a partial BODY.PEEK fetch). Pure functions: the input may be cut
// anywhere, mid base64/QP unit or mid character, and the result is only ever
// rendered as text.

export const SNIPPET_MAX = 140;

// Decodes the content-transfer-encoding of a possibly truncated slice.
function decodeTransfer(buf, encoding) {
	const enc = String(encoding || "").toLowerCase();
	if (enc === "base64") {
		const clean = buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
		return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
	}
	if (enc === "quoted-printable") {
		// Drop a trailing partial escape ("=", "=A") or soft break cut short.
		const text = buf.toString("latin1").replace(/=[0-9A-Fa-f]?$|=\r$/, "").replace(/=\r?\n/g, "");
		const out = [];
		for (let i = 0; i < text.length; i++) {
			const hex = text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3));
			out.push(hex ? Number.parseInt(text.slice(i + 1, i + 3), 16) : text.charCodeAt(i) & 0xff);
			if (hex) i += 2;
		}
		return Buffer.from(out);
	}
	return buf;
}

// Charset decode; `stream: true` holds back a multi-byte character cut at the
// end instead of emitting a replacement glyph. Unknown charset: utf-8, then latin1.
function decodeCharset(bytes, charset) {
	if (charset) {
		try {
			return new TextDecoder(charset).decode(bytes, { stream: true });
		} catch {
			// unsupported label: fall through
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
	} catch {
		return new TextDecoder("latin1").decode(bytes);
	}
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function codePoint(n) {
	return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

// A simple text extraction: no markup survives, quoted blocks are dropped.
export function htmlToText(html) {
	return html
		.replace(/<!--[\s\S]*?(-->|$)/g, " ")
		.replace(/<(head|style|script|title|blockquote)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ")
		.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]*(>|$)/g, " ")
		.replace(/&[#\w]*$/, "")
		.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
			if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
			return codePoint(e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
		});
}

// Drops quoted-reply lines, "On … wrote:" lead-ins and the signature, then
// collapses whitespace and trims to `max` code points with an ellipsis.
// C0/C1 controls, bidi controls and lone surrogates (pairs survive: "u" flag).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]|\p{Cs}/gu;

export function cleanSnippet(text, max = SNIPPET_MAX) {
	const kept = [];
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (t === "--") break;
		if (t.startsWith(">") || /^on\b.{0,200}\bwrote:$/i.test(t)) continue;
		kept.push(t);
	}
	const flat = kept.join(" ").replace(/\s+/g, " ").replace(UNSAFE, "").trim();
	const chars = Array.from(flat);
	if (chars.length <= max) return flat;
	return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// part: { type, encoding, charset } from the BODYSTRUCTURE node.
export function snippetFromPart(buf, part = {}, max = SNIPPET_MAX) {
	if (!Buffer.isBuffer(buf) || !buf.length) return undefined;
	const text = decodeCharset(decodeTransfer(buf, part.encoding), part.charset);
	const isHtml = String(part.type || "").toLowerCase() === "text/html";
	return cleanSnippet(isHtml ? htmlToText(text) : text, max) || undefined;
}
