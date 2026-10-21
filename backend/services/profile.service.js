import { getSetting, setSetting } from "../db.js";
import { getUser } from "../plugins/auth.plugin.js";

// Per-mailbox profile (currently the From display name), stored in sqlite.
const nameKey = (mailbox) => `profile:name:${mailbox.toLowerCase().trim()}`;

export function getDisplayName(mailbox) {
	return getSetting(nameKey(mailbox)) || "";
}

// Header-safe: no CR/LF, trimmed, bounded.
export function cleanDisplayName(name) {
	return String(name || "")
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 100);
}

export const ProfileService = {
	get: async ({ cookie, status }) => {
		const user = await getUser(cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });
		return { success: true, data: { displayName: getDisplayName(user.mailbox) } };
	},

	put: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });
		const displayName = cleanDisplayName(body.displayName);
		setSetting(nameKey(user.mailbox), displayName);
		return { success: true, data: { displayName } };
	},
};
