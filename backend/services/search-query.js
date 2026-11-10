// Turns the mailbox search box into an imapflow search object. Supported
// operators (names case-insensitive): from:, to:, subject: (value may be
// "double quoted"), is:unread|read|starred|unstarred, before:/after:YYYY-MM-DD.
// Anything unrecognised (unknown operator, bad date, unbalanced quote) stays
// plain text, and a string with no operators is exactly { text: input }.
// When an operator repeats, the last one wins (IMAP query keys are unique).

// op:"quoted value" (closing quote must end the token) | any other word.
const TOKEN = /([A-Za-z]+):"([^"]*)"(?=\s|$)|\S+/g;
const OPERATOR = /^([A-Za-z]+):(.+)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT_FIELDS = new Set(["from", "to", "subject"]);
const IS_VALUES = {
	unread: ["seen", false],
	read: ["seen", true],
	starred: ["flagged", true],
	unstarred: ["flagged", false],
};

// UTC midnight of a real calendar date, or null (rejects 2026-02-30).
// Dates are interpreted as UTC days. Servers that compare date-only (plain
// BEFORE/SINCE) see that day; imapflow may instead send OLDER/YOUNGER (the
// WITHIN extension) computed relative to this UTC instant.
function parseDate(value) {
	const m = DATE.exec(value);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(Date.UTC(y, mo - 1, d));
	if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
	return date;
}

// [key, value] for an operator token, or null to keep it as plain text.
function operator(name, value, quoted) {
	const op = name.toLowerCase();
	if (!value) return null;
	// A stray (unbalanced) quote in an unquoted value means plain text.
	if (!quoted && value.includes('"')) return null;
	if (TEXT_FIELDS.has(op)) return [op, value];
	// Only text fields take quoted values.
	if (quoted) return null;
	if (op === "is") return IS_VALUES[value.toLowerCase()] || null;
	if (op === "before" || op === "after") {
		const date = parseDate(value);
		// IMAP BEFORE is exclusive of the day; SINCE (after:) includes it.
		return date ? [op === "before" ? "before" : "since", date] : null;
	}
	return null;
}

export function parseSearchQuery(input) {
	const raw = String(input ?? "");
	if (!raw.trim()) return {};
	const query = {};
	const words = [];
	let found = false;
	for (const match of raw.matchAll(TOKEN)) {
		const [token, quotedName, quotedValue] = match;
		const plain = quotedName === undefined ? OPERATOR.exec(token) : null;
		const parsed = quotedName !== undefined
			? operator(quotedName, quotedValue, true)
			: plain && operator(plain[1], plain[2], false);
		if (parsed) {
			query[parsed[0]] = parsed[1];
			found = true;
		} else {
			words.push(token);
		}
	}
	if (!found) return { text: raw };
	if (words.length) query.text = words.join(" ");
	return query;
}
