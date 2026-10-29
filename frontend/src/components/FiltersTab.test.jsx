import { fireEvent, render, screen } from "@testing-library/react";
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

test("saving disabled rules reports their actual state and keeps rows editable", async () => {
	const rules = [
		{ field: "subject", match: "contains", value: "one", folder: "A" },
		{ field: "subject", match: "contains", value: "two", folder: "B" },
	];
	mockApi({ "GET /filters": { rules, enabled: false }, "PUT /filters": { ruleCount: 2, enabled: false } });
	render(<FiltersTab mailbox="me@x.io" />);
	await screen.findByDisplayValue("one");
	fireEvent.click(screen.getByText("Save"));
	await screen.findByText("Saved — filtering is disabled.");
	fireEvent.click(screen.getAllByTitle("Remove this filter")[0]);
	expect(screen.queryByDisplayValue("one")).toBeNull();
	expect(screen.getByDisplayValue("two")).toBeTruthy();
});
