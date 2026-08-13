import { LLM } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { generalLogger as logger } from "../logger.js";

// Probes the configured LLM server at boot and records LLM_PRESENT in sqlite.
// Supports both standard OpenAI-compatible (GET {server}/v1/models with Bearer
// key) and ollama (GET {server}/api/tags). Returns true/false.
export async function probeAndRecordLLM() {
	if (!LLM.server) {
		setSetting("LLM_PRESENT", "false");
		logger.info("[LLM] — LLM_SERVER not set — summarization disabled");
		return false;
	}

	const attempts = [
		{ url: `${LLM.server.replace(/\/$/, "")}/v1/models`, auth: true },
		{ url: `${LLM.server.replace(/\/$/, "")}/api/tags`, auth: false },
	];

	for (const { url, auth } of attempts) {
		try {
			const headers = { Accept: "application/json" };
			if (auth && LLM.apiKey) headers.Authorization = `Bearer ${LLM.apiKey}`;
			const res = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(4000),
			});
			if (res.ok) {
				setSetting("LLM_PRESENT", "true");
				logger.info(
					`[LLM] ✅ LLM is present at ${LLM.server} — email summarization enabled`,
				);
				return true;
			}
			logger.warn(`[LLM] probe ${url} -> HTTP ${res.status}`);
		} catch (err) {
			logger.warn(`[LLM] probe ${url} failed: ${err?.message}`);
		}
	}

	setSetting("LLM_PRESENT", "false");
	logger.warn("[LLM] server unreachable — summarization disabled");
	return false;
}

export function isLLMPresent() {
	return getSetting("LLM_PRESENT") === "true";
}

// Summarizes a message body via the configured LLM (OpenAI-compatible chat).
export async function summarizeText(text) {
	if (!isLLMPresent() || !LLM.server) {
		return { success: false, message: "LLM not available" };
	}

	const clean = (text || "").toString().slice(0, 12000);
	if (!clean.trim()) {
		return { success: false, message: "No message text to summarize" };
	}

	const base = LLM.server.replace(/\/$/, "");
	const url = `${base}/v1/chat/completions`;
	const body = {
		model: process.env.LLM_MODEL || "qwen2.5",
		messages: [
			{
				role: "system",
				content:
					"You are a concise email assistant. Summarize the email in 3-5 short bullet points covering what it is about and any action required. No preamble.",
			},
			{ role: "user", content: clean },
		],
		max_tokens: 300,
		temperature: 0.3,
		stream: false,
	};

	try {
		const headers = { "Content-Type": "application/json" };
		if (LLM.apiKey) headers.Authorization = `Bearer ${LLM.apiKey}`;
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(40000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			logger.warn(`[LLM] summarize HTTP ${res.status}: ${text.slice(0, 300)}`);
			return { success: false, message: `LLM returned ${res.status}` };
		}
		const data = await res.json();
		const summary = data?.choices?.[0]?.message?.content;
		if (!summary) {
			return { success: false, message: "LLM returned no summary" };
		}
		return { success: true, data: { summary: summary.trim() } };
	} catch (err) {
		logger.warn(`[LLM] summarize error: ${err?.message}`);
		return { success: false, message: err?.message || "LLM request failed" };
	}
}