async function request(path, { method = "GET", body, signal } = {}) {
	const res = await fetch(`/api/v1${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		credentials: "include",
		body: body ? JSON.stringify(body) : undefined,
		signal,
	});

	const contentType = res.headers.get("content-type") || "";
	const json = contentType.includes("application/json")
		? await res.json()
		: null;

	if (!res.ok) {
		const err = new Error(json?.message || `HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}

	return json;
}

export const apiCall = {
	get: (path, opts) => request(path, { ...opts }),
	post: (path, body, opts) => request(path, { method: "POST", body, ...opts }),
};