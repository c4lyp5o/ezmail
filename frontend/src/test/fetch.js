import { vi } from "vitest";

// Stubs global fetch with a tiny router: { "GET /mail/folders": data | fn }.
// Handlers return the envelope `data`; { status, json } overrides the reply.
export function mockApi(routes) {
	const calls = [];
	const fetch = vi.fn(async (url, init = {}) => {
		const method = init.method || "GET";
		const path = String(url).replace(/^\/api\/v1/, "").split("?")[0];
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, path, url: String(url), body });
		const route = routes[`${method} ${path}`];
		let out = typeof route === "function" ? route(body, String(url)) : route;
		if (out === undefined) out = { status: 404, json: { success: false, message: "nope" } };
		const { status = 200, json = { success: true, data: out } } =
			out && (out.status || out.json) ? out : { json: { success: true, data: out } };
		return new Response(JSON.stringify(json), {
			status,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetch);
	return calls;
}
