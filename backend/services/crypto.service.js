import crypto from "node:crypto";
import { getSetting } from "../db.js";

// At-rest encryption for stored mailbox passwords (TOTP enrollment and
// server-side sessions): AES-256-GCM, random 96-bit IV per value.

// Key: TOTP_ENC_KEY (preferred; the name predates sessions), else JWT_SECRET,
// else a random secret generated at first boot and kept in sqlite.
function encryptionKey() {
	const secret =
		process.env.TOTP_ENC_KEY ||
		process.env.JWT_SECRET ||
		getSetting("jwtSecret") ||
		"";
	const digest = crypto.createHash("sha256").update(secret).digest();
	return digest; // 32 bytes for AES-256
}

export function encryptSecret(text) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
	const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload) {
	try {
		const [ivB64, tagB64, dataB64] = payload.split(".");
		const decipher = crypto.createDecipheriv(
			"aes-256-gcm",
			encryptionKey(),
			Buffer.from(ivB64, "base64"),
		);
		decipher.setAuthTag(Buffer.from(tagB64, "base64"));
		return Buffer.concat([
			decipher.update(Buffer.from(dataB64, "base64")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return null;
	}
}
