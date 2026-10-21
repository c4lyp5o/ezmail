import { afterEach, describe, expect, test } from "bun:test";
import {
	getLLMMode,
	isLLMPresent,
	probeAndRecordLLM,
	summarizeText,
} from "../services/llm.service.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

// Routes fetch by URL path; records every request.
function serve(routes) {
	const seen = [];
	globalThis.fetch = async (url, init = {}) => {
		const { pathname } = new URL(url);
		seen.push({ path: pathname, body: init.body ? JSON.parse(init.body) : null });
		const handler = routes[pathname];
		if (!handler) return new Response("nope", { status: 404 });
		return Response.json(handler());
	};
	return seen;
}

describe("probe", () => {
	test("Ollama is detected first (it also serves /v1/models)", async () => {
		serve({ "/api/tags": () => ({}), "/v1/models": () => ({}) });
		expect(await probeAndRecordLLM()).toBe(true);
		expect(getLLMMode()).toBe("ollama");
		expect(isLLMPresent()).toBe(true);
	});

	test("falls back to OpenAI-compatible", async () => {
		serve({ "/v1/models": () => ({ data: [] }) });
		expect(await probeAndRecordLLM()).toBe(true);
		expect(getLLMMode()).toBe("openai");
	});

	test("unreachable server disables summarization", async () => {
		globalThis.fetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect(await probeAndRecordLLM()).toBe(false);
		expect(isLLMPresent()).toBe(false);
		expect((await summarizeText("hi")).success).toBe(false);
	});
});

describe("summarize", () => {
	test("Ollama: /api/chat with think:false", async () => {
		serve({ "/api/tags": () => ({}) });
		await probeAndRecordLLM();
		const seen = serve({ "/api/chat": () => ({ message: { content: " - point " } }) });
		const res = await summarizeText("an email");
		expect(res).toEqual({ success: true, data: { summary: "- point" } });
		expect(seen[0].path).toBe("/api/chat");
		expect(seen[0].body).toMatchObject({ stream: false, think: false });
	});

	test("OpenAI: /v1/chat/completions, reads choices[0]", async () => {
		serve({ "/v1/models": () => ({}) });
		await probeAndRecordLLM();
		const seen = serve({
			"/v1/chat/completions": () => ({ choices: [{ message: { content: "sum" } }] }),
		});
		const res = await summarizeText("an email");
		expect(res.data.summary).toBe("sum");
		expect(seen[0].body.think).toBeUndefined();
	});

	test("blank text is rejected without calling the LLM", async () => {
		serve({ "/api/tags": () => ({}) });
		await probeAndRecordLLM();
		const seen = serve({});
		expect((await summarizeText("   ")).success).toBe(false);
		expect(seen).toHaveLength(0);
	});
});
