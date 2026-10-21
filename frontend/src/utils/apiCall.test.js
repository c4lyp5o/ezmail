import { expect, test } from "vitest";
import { mockApi } from "../test/fetch.js";
import { apiCall } from "./apiCall.js";

test("returns the JSON envelope and sends JSON bodies", async () => {
	const calls = mockApi({ "POST /mail/send": { ok: 1 } });
	const res = await apiCall.post("/mail/send", { to: "a@x.io" });
	expect(res).toEqual({ success: true, data: { ok: 1 } });
	expect(calls[0]).toMatchObject({ method: "POST", body: { to: "a@x.io" } });
	expect(fetch.mock.calls[0][1]).toMatchObject({
		credentials: "include",
		headers: { "Content-Type": "application/json" },
	});
});

test("non-2xx throws with the server message and status", async () => {
	mockApi({
		"POST /mail/send": { status: 502, json: { success: false, message: "relay denied" } },
	});
	await expect(apiCall.post("/mail/send", {})).rejects.toMatchObject({
		message: "relay denied",
		status: 502,
	});
});
