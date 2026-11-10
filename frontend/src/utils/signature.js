// Email signature helpers. The signature is plain text, separated from the
// body by the standard "-- " delimiter line (note the trailing space).

export const signatureBlock = (signature) =>
	signature?.trim() ? `\n\n-- \n${signature.replace(/\r\n?/g, "\n")}` : "";

// Puts the signature at the top of the body: for a new message the body is
// just the signature; for a reply/forward it sits above the quoted text, so
// typing starts above it.
export const addSignature = (text, signature) => `${signatureBlock(signature)}${text || ""}`;

const URL_TOKEN = /^(https?:\/\/|www\.)\S+$/i;
const escapeToken = (token) => {
	// A bare URL is autolinked as typed, unless it carries markup characters.
	if (URL_TOKEN.test(token) && !/[<>`[\]\\*|]/.test(token)) return token;
	// An address, bare or in <angle brackets>: the conservative character set
	// can't form an HTML tag or link, and markdown renders both as a mailto link.
	if (/^<?[\w.+%-]+@[\w-]+(\.[\w-]+)+>?$/.test(token)) return token;
	return token
		.replace(/[\\`*[\]<>~|]/g, "\\$&")
		.replace(/(^|[^\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (m) => m.replace("_", "\\_"));
};

// Backslash-escapes characters that markdown would turn into markup, per
// whitespace-separated token (URLs and email addresses stay intact, intraword
// underscores aren't emphasis), plus block markers at the start of a line.
const escapeMarkdownLine = (line) => {
	const indent = line.match(/^\s*/)[0];
	const body = line.slice(indent.length).split(/(\s+)/).map((t, i) => (i % 2 ? t : escapeToken(t))).join("");
	return indent + body
		.replace(/^([#>=])/, "\\$1")
		.replace(/^([-+*])(?=\s|$)/, "\\$1")
		.replace(/^-(?=-*\s*$)/, "\\-")
		.replace(/^(\d+)([.)])/, "$1\\$2");
};

// When the body is sent as markdown, keep a still-unedited signature plain:
// escape it, keep its line breaks (trailing double space = <br>) and give the
// "-- " line its own paragraph so the delimiter itself stays exact.
export function markdownSafeSignature(text, signature) {
	const block = signatureBlock(signature);
	if (!block) return text;
	const sig = block.slice("\n\n-- \n".length);
	const marker = `-- \n${sig}`;
	const at = text.lastIndexOf(marker);
	if (at < 0 || (at > 0 && text[at - 1] !== "\n")) return text;
	const before = text.slice(0, at).replace(/\n*$/, at > 0 ? "\n\n" : "");
	const safe = sig.split("\n").map(escapeMarkdownLine).join("  \n");
	return `${before}-- \n\n${safe}${text.slice(at + marker.length)}`;
}
