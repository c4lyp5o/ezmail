import { getSetting, setSetting } from "../db.js";
import { getUser } from "../plugins/auth.plugin.js";

// Per-mailbox profile (From display name, plain-text signature), stored in sqlite.
const nameKey = (mailbox) => `profile:name:${mailbox.toLowerCase().trim()}`;
const signatureKey = (mailbox) => `profile:signature:${mailbox.toLowerCase().trim()}`;
export const MAX_SIGNATURE_LENGTH = 2000;

export function getDisplayName(mailbox) {
	return getSetting(nameKey(mailbox)) || "";
}

export function getSignature(mailbox) {
	return getSetting(signatureKey(mailbox)) || "";
}

// Header-safe: no CR/LF, trimmed, bounded.
export function cleanDisplayName(name) {
	return String(name || "")
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 100);
}

// Plain text: CRLF/CR become LF, other control characters (except tab) are
// dropped, trailing whitespace trimmed; whitespace-only clears it. Length is
// checked by the caller after normalising.
export function cleanSignature(signature) {
	const text = [...String(signature || "").replace(/\r\n?/g, "\n")]
		.filter((c) => {
			const code = c.charCodeAt(0);
			return c === "\n" || c === "\t" || (code >= 32 && code !== 127);
		})
		.join("")
		.trimEnd();
	return text.trim() ? text : "";
}

export const ProfileService = {
	get: async ({ cookie, status }) => {
		const user = await getUser(cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });
		return {
			success: true,
			data: { displayName: getDisplayName(user.mailbox), signature: getSignature(user.mailbox) },
		};
	},

	// Each field is optional; an omitted field keeps its saved value.
	put: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });
		let signature;
		if (body.signature !== undefined) {
			signature = cleanSignature(body.signature);
			if (signature.length > MAX_SIGNATURE_LENGTH)
				return status(400, { success: false, message: `Signature is limited to ${MAX_SIGNATURE_LENGTH} characters.` });
		}
		if (body.displayName !== undefined) setSetting(nameKey(user.mailbox), cleanDisplayName(body.displayName));
		if (signature !== undefined) setSetting(signatureKey(user.mailbox), signature);
		return {
			success: true,
			data: { displayName: getDisplayName(user.mailbox), signature: getSignature(user.mailbox) },
		};
	},
};
