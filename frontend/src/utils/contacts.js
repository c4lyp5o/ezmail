// Recipient history for To/Cc/Bcc autocomplete, kept only in this browser's
// localStorage, one list per mailbox. Entries are { address, name }, most
// recently used first. Storage can be unavailable (private mode, quota), so
// every access is wrapped and failures just mean no suggestions.

const PREFIX = "ezmail_contacts:";
export const MAX_CONTACTS = 200;
const MAX_SUGGESTIONS = 6;

const keyFor = (mailbox) => `${PREFIX}${mailbox || ""}`;

function load(mailbox) {
	try {
		const list = JSON.parse(localStorage.getItem(keyFor(mailbox)));
		return Array.isArray(list) ? list.filter((c) => typeof c?.address === "string") : [];
	} catch {
		return [];
	}
}

// "Ada <ada@x.io>", "\"Ada L\" <ada@x.io>" or "ada@x.io" → { address, name }.
export function parseAddress(token) {
	const s = String(token || "").trim();
	const angle = s.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>$/);
	if (angle) return { address: angle[2], name: angle[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(["\\])/g, "$1").trim() };
	return /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(s) ? { address: s, name: "" } : null;
}

// Splits a To/Cc/Bcc field value into tokens on commas and semicolons.
// Separators inside "double quotes" or <angle brackets> don't split.
export function splitRecipients(value) {
	const parts = [];
	let cur = "";
	let quoted = false;
	let angle = false;
	for (const ch of String(value || "")) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === "<") angle = true;
		else if (!quoted && ch === ">") angle = false;
		if ((ch === "," || ch === ";") && !quoted && !angle) {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	parts.push(cur);
	return parts;
}

// `addresses`: field values or single addresses, in the order they were used.
export function rememberContacts(mailbox, addresses) {
	const fresh = [];
	for (const value of [].concat(addresses || [])) {
		for (const token of splitRecipients(value)) {
			const c = parseAddress(token);
			if (c && !fresh.some((f) => f.address.toLowerCase() === c.address.toLowerCase())) fresh.push(c);
		}
	}
	if (!fresh.length) return;
	const seen = new Set(fresh.map((c) => c.address.toLowerCase()));
	const old = load(mailbox);
	// Keep a known display name when this send only used the bare address.
	for (const c of fresh) {
		if (!c.name) c.name = old.find((o) => o.address.toLowerCase() === c.address.toLowerCase())?.name || "";
	}
	const next = [...fresh, ...old.filter((c) => !seen.has(c.address.toLowerCase()))].slice(0, MAX_CONTACTS);
	try {
		localStorage.setItem(keyFor(mailbox), JSON.stringify(next));
	} catch {
		// storage unavailable or full; autocomplete just stays as it was
	}
}

// Prefix matches (address or name, or any word of the name) first, then
// substring matches, each group in most-recently-used order.
export function suggestContacts(mailbox, prefix) {
	const q = String(prefix || "").trim().toLowerCase();
	if (!q) return [];
	const starts = [];
	const contains = [];
	for (const c of load(mailbox)) {
		const address = c.address.toLowerCase();
		const name = (c.name || "").toLowerCase();
		if (address.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) starts.push(c);
		else if (address.includes(q) || name.includes(q)) contains.push(c);
	}
	return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

// No mailbox: forget every mailbox's history (logout).
export function clearContacts(mailbox) {
	try {
		if (mailbox !== undefined) {
			localStorage.removeItem(keyFor(mailbox));
			return;
		}
		const keys = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k?.startsWith(PREFIX)) keys.push(k);
		}
		for (const k of keys) localStorage.removeItem(k);
	} catch {
		// storage unavailable; nothing stored to clear
	}
}
