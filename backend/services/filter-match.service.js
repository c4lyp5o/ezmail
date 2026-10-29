// Sieve's default i;ascii-casemap comparator folds ASCII letters only.
const fold = (value) => String(value || "").replace(/[A-Z]/g, (char) => char.toLowerCase());

function addresses(entries) {
	return (entries || []).flatMap((entry) => entry.group ? addresses(entry.group) : entry.address ? [entry.address] : []);
}

// Match envelope addresses rather than display names, like Sieve's address test.
export function matchFilter(rule, envelope) {
	const values = rule.field === "subject" ? [envelope?.subject || ""] : addresses(envelope?.[rule.field]);
	const expected = fold(rule.value);
	return values.some((value) => {
		const actual = fold(value);
		return rule.match === "is" ? actual === expected : actual.includes(expected);
	});
}

export function firstMatchingFilter(rules, envelope) {
	return rules.find((rule) => matchFilter(rule, envelope));
}
