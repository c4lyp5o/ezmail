import path from "node:path";

export const ROOT_DIR = path.join(import.meta.dir, "..");
export const BACKEND_DIR = path.join(ROOT_DIR, "backend");
export const CLIENT_DIR = path.join(ROOT_DIR, "frontend", "dist");
export const DATA_DIR = path.join(BACKEND_DIR, "data");
export const LOG_DIR = path.join(ROOT_DIR, "logs");

// Infra connection settings come from .env ONLY — these are environment
// config, not something a user should type into the web UI at setup time.
export const MAIL_SERVER = {
	imapHost: process.env.IMAP_HOST || "mail.example.com",
	imapPort: Number(process.env.IMAP_PORT) || 993,
	imapSecure: process.env.IMAP_SECURE !== "false",
	smtpHost: process.env.SMTP_HOST || "mail.example.com",
	smtpPort: Number(process.env.SMTP_PORT) || 587,
	smtpSecure: process.env.SMTP_SECURE === "true",
};

export const DB_PATH = path.join(DATA_DIR, "ezmail.db");

// Local LLM (ollama/openai-compatible) for message summarization. Optional —
// if absent, LLM_PRESENT stays false and the summary column is hidden.
export const LLM = {
	server: process.env.LLM_SERVER || "",
	apiKey: process.env.LLM_SERVER_APIKEY || "",
};