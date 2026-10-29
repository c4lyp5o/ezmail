// Test preload: isolate all on-disk state and replace the network clients
// (IMAP/SMTP) with in-memory fakes before any service module is imported.
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "ezmail-test-"));
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.MAIL_DATA_DIR = path.join(TMP, "mail");
process.env.TOTP_ENC_KEY = "test-totp-key";
process.env.LLM_SERVER = "http://llm.test";
process.env.IMAP_POOL_IDLE_MS = "0"; // pool tests opt in explicitly

const { FakeImapFlow } = await import("./helpers/fake-imap.js");
const { fakeNodemailer } = await import("./helpers/fake-smtp.js");

mock.module("imapflow", () => ({ ImapFlow: FakeImapFlow }));
mock.module("nodemailer", () => ({ default: fakeNodemailer }));
