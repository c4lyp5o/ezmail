import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import encodeQR from "qr";
import { getSetting, setSetting } from "../db.js";

// TOTP-based passwordless login for ezmail.
//
// ezmail is an IMAP/SMTP proxy, so the mailbox password must be retained
// server-side to authenticate to the mail server after a code-only login.
// The password is captured ONCE during enrollment, verified against IMAP,
// then stored encrypted at rest (AES-256-GCM, key derived from JWT_SECRET).
// After that, login asks only for a 6-digit TOTP code.

const ISSUER = "ezmail";

// ---- settings keys (per mailbox) ----
const keyFor = (mailbox) => {
	const k = mailbox.toLowerCase().trim();
	return {
		secret: `totp:secret:${k}`,
		enabled: `totp:enabled:${k}`,
		passEnc: `totp:passEnc:${k}`,
		verifyMailbox: `totp:mailbox:${k}`,
	};
};

// ---- key derivation (reuse JWT_SECRET — stable across restarts) ----
function encryptionKey() {
	const secret = process.env.JWT_SECRET || getSetting("jwtSecret") || "";
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

// ---- secret / QR ----
function makeSecret() {
	return new OTPAuth.Secret({ size: 32 }); // 32 bytes -> ~52 char base32
}

function totpFor(mailbox, secretBase32) {
	return new OTPAuth.TOTP({
		issuer: ISSUER,
		label: mailbox,
		secret: OTPAuth.Secret.fromBase32(secretBase32),
	});
}

function toQRDataUri(otpauthUri) {
	const gif = encodeQR(otpauthUri, "gif", { scale: 4 });
	return `data:image/gif;base64,${Buffer.from(gif).toString("base64")}`;
}

// Enroll phase 1: generate a fresh secret, persist it (not yet enabled), and
// return the otpauth URI + QR so the user can scan it into an authenticator.
// If a mailbox password is supplied (passwordless bootstrap), we encrypt and
// store it too.
export function beginEnroll(mailbox, password) {
	const k = keyFor(mailbox);
	const secret = makeSecret().base32;
	setSetting(k.secret, secret);
	if (typeof password === "string" && password.length > 0) {
		setSetting(k.passEnc, encryptSecret(password));
	}
	const uri = totpFor(mailbox, secret).toString();
	return { secret, qrCode: toQRDataUri(uri), otpauthUri: uri };
}

// Enroll phase 2: validate the 6-digit code against the pending secret. On
// success, mark TOTP enabled for this mailbox. Returns { ok, message }.
export function completeEnroll(mailbox, token) {
	const k = keyFor(mailbox);
	const secret = getSetting(k.secret);
	if (!secret) return { ok: false, message: "No pending enrollment. Restart enrollment." };

	const delta = totpFor(mailbox, secret).validate({ token, window: 1 });
	if (delta === null) return { ok: false, message: "Invalid code. Check your authenticator and try again." };

	setSetting(k.enabled, "true");
	setSetting(k.verifyMailbox, mailbox.toLowerCase().trim());
	return { ok: true };
}

// Status for a mailbox.
export function totpStatus(mailbox) {
	if (!mailbox) return { enabled: false, enrolled: false };
	const k = keyFor(mailbox);
	return {
		enabled: getSetting(k.enabled) === "true",
		enrolled: Boolean(getSetting(k.secret)),
	};
}

// Login: verify a TOTP code for passwordless access. Returns the stored,
// decrypted mailbox password on success (for the IMAP proxy) or null.
export function verifyLoginCode(mailbox, token) {
	const k = keyFor(mailbox);
	if (getSetting(k.enabled) !== "true") return { ok: false, reason: "not-enabled" };
	const secret = getSetting(k.secret);
	if (!secret) return { ok: false, reason: "not-enrolled" };

	const delta = totpFor(mailbox, secret).validate({ token, window: 1 });
	if (delta === null) return { ok: false, reason: "invalid-code" };

	const enc = getSetting(k.passEnc);
	const password = enc ? decryptSecret(enc) : null;
	return { ok: true, password };
}

// Disable TOTP for a mailbox (e.g. from settings). Removes secret + stored
// password so the mailbox falls back to password login.
export function disableTotp(mailbox) {
	const k = keyFor(mailbox);
	setSetting(k.enabled, "false");
}