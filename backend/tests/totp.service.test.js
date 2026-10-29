import { describe, expect, test } from "bun:test";
import {
	beginEnroll,
	decryptSecret,
	disableTotp,
	encryptSecret,
	totpStatus,
	verifyLoginCode,
} from "../services/totp.service.js";

describe("password encryption at rest", () => {
	test("round-trips and uses a fresh IV each time", () => {
		const a = encryptSecret("hunter2");
		const b = encryptSecret("hunter2");
		expect(a).not.toBe(b);
		expect(decryptSecret(a)).toBe("hunter2");
	});

	test("tampered ciphertext fails closed", () => {
		const [iv, tag, data] = encryptSecret("hunter2").split(".");
		const flipped = Buffer.from(data, "base64");
		flipped[0] ^= 1;
		expect(decryptSecret([iv, tag, flipped.toString("base64")].join("."))).toBeNull();
		expect(decryptSecret("garbage")).toBeNull();
	});
});

describe("enrollment state", () => {
	test("pending enrollment is not enabled; disable wipes it", () => {
		const mailbox = `Pending-${Date.now()}@x.io`;
		const { qrCode, otpauthUri } = beginEnroll(mailbox, "pw");
		expect(qrCode).toStartWith("data:image/gif;base64,");
		expect(otpauthUri).toStartWith("otpauth://totp/");
		// keys are case-insensitive
		expect(totpStatus(mailbox.toLowerCase())).toEqual({ enabled: false, enrolled: true });
		expect(verifyLoginCode(mailbox, "123456")).toEqual({ ok: false, reason: "not-enabled" });
		disableTotp(mailbox);
		expect(totpStatus(mailbox)).toEqual({ enabled: false, enrolled: false });
	});
});
