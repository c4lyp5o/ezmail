export const FIELDS = [
	{ value: "from", label: "From" },
	{ value: "subject", label: "Subject" },
	{ value: "to", label: "To" },
];

export const MATCHES = [
	{ value: "contains", label: "contains" },
	{ value: "is", label: "is exactly" },
];

// Mirrors the server's folder-name rule so the picker never offers a name the API rejects.
export const validFolderName = (name) => /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) && !name.includes("..");

// Sieve's default i;ascii-casemap comparator folds ASCII letters only.
const fold = (value) => String(value || "").replace(/[A-Z]/g, (char) => char.toLowerCase());

// "Ada <ada@x.io>, bob@y.io" -> ["ada@x.io", "bob@y.io"]; rules compare addresses, not display names.
const addresses = (text) => text.split(",").map((part) => (part.match(/<([^>]*)>/)?.[1] ?? part).trim()).filter(Boolean);

// Same semantics as the server filters, applied to a hand-typed sample message.
export function ruleMatches(rule, sample) {
	const raw = (sample[rule.field] || "").trim();
	if (!raw || !rule.value.trim() || !rule.folder) return false;
	const expected = fold(rule.value);
	const values = rule.field === "subject" ? [raw] : addresses(raw);
	return values.some((value) => {
		const actual = fold(value);
		return rule.match === "is" ? actual === expected : actual.includes(expected);
	});
}

const label = (list, value) => list.find((item) => item.value === value)?.label ?? value;

export function describeRule(rule) {
	return `If ${label(FIELDS, rule.field)} ${label(MATCHES, rule.match)} "${rule.value}", move to ${rule.folder}.`;
}
