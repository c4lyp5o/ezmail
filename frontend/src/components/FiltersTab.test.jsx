import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockApi } from "../test/fetch.js";
import FiltersTab from "./FiltersTab.jsx";

test("a custom active script is visible but cannot be edited", async () => {
	mockApi({ "GET /filters": { rules: [], enabled: true, conflict: true, sieveSource: 'redirect "other@example.com";' } });
	render(<FiltersTab mailbox="me@x.io" />);
	await screen.findByText(/not an ezmail-generated script/);
	expect(screen.getByText('redirect "other@example.com";')).toBeTruthy();
	expect(screen.getByText("Save").closest("fieldset").disabled).toBe(true);
});

test("connection errors are visible and prevent saving", async () => {
	mockApi({ "GET /filters": { status: 502, json: { success: false, message: "ManageSieve unavailable" } } });
	render(<FiltersTab mailbox="me@x.io" />);
	await screen.findByText("ManageSieve unavailable");
	expect(screen.getByText("Save").disabled).toBe(true);
});
