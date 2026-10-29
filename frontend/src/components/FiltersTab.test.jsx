import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
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

test("offers continuous ezmail filtering when server filtering is unavailable", async () => {
	const calls = mockApi({
		"GET /filters": { mode: "unavailable", rules: [], enabled: false },
		"PUT /filters": { ruleCount: 1, enabled: true },
	});
	render(<FiltersTab mailbox="me@x.io" />);
	await screen.findByText(/Server-side filtering is unavailable/);
	expect(screen.getByText("Save").closest("fieldset").disabled).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "Use ezmail filtering" }));
	expect(screen.getByText(/including after you sign out/)).toBeTruthy();
	fireEvent.click(screen.getByText("Add filter"));
	fireEvent.change(screen.getByLabelText("Rule 1: text to match"), { target: { value: "invoice" } });
	fireEvent.change(screen.getByLabelText("Rule 1: destination folder"), { target: { value: "\0new" } });
	fireEvent.change(screen.getByLabelText("Rule 1: new folder name"), { target: { value: "Bills" } });
	fireEvent.click(screen.getByText("Save"));
	await screen.findByText("Saved — ezmail will check for new mail.");
	expect(calls.find((call) => call.method === "PUT").body).toMatchObject({ mode: "imap", enabled: true });
});

const two = [
	{ field: "subject", match: "contains", value: "invoice", folder: "Finance" },
	{ field: "from", match: "contains", value: "example.com", folder: "Other" },
];
const folders = [{ path: "Finance" }, { path: "Other" }];

test("rules can be reordered and the order is saved", async () => {
	const calls = mockApi({ "GET /filters": { rules: two, enabled: true }, "PUT /filters": { ruleCount: 2, enabled: true } });
	render(<FiltersTab mailbox="me@x.io" folders={folders} />);
	await screen.findByDisplayValue("invoice");
	expect(screen.getByRole("button", { name: "Move rule 1 up" }).getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "Move rule 1 down" }));
	expect(screen.getByLabelText("Rule 1: text to match").value).toBe("example.com");
	expect(screen.getByText("Rule moved to position 2 of 2")).toBeTruthy();
	fireEvent.click(screen.getByText("Save"));
	await screen.findByText(/Saved/);
	expect(calls.find((c) => c.method === "PUT").body.rules.map((r) => r.value)).toEqual(["example.com", "invoice"]);
});

test("test rule reports the first matching rule and destination without calling the API", async () => {
	const calls = mockApi({ "GET /filters": { rules: two, enabled: true } });
	render(<FiltersTab mailbox="me@x.io" folders={folders} />);
	await screen.findByDisplayValue("invoice");
	fireEvent.change(screen.getByLabelText("Sample subject"), { target: { value: "March INVOICE" } });
	fireEvent.change(screen.getByLabelText("Sample from"), { target: { value: "Ann <ann@Example.com>" } });
	expect(screen.getByText(/Rule 1 matches\. If Subject contains "invoice", move to Finance\..*Also matches rule 2/)).toBeTruthy();
	fireEvent.change(screen.getByLabelText("Sample subject"), { target: { value: "hello" } });
	fireEvent.change(screen.getByLabelText("Sample from"), { target: { value: "x@else.test" } });
	expect(screen.getByText("No rule matches. The message would stay in Inbox.")).toBeTruthy();
	expect(calls.every((c) => c.method === "GET")).toBe(true);
});

test("shows the fallback method and its current error", async () => {
	mockApi({ "GET /filters": { mode: "imap", rules: [], enabled: true, lastError: "Filtering failed. Check it." } });
	render(<FiltersTab mailbox="me@x.io" />);
	expect(await screen.findByText("ezmail fallback")).toBeTruthy();
	expect(screen.getByText(/Problem: Filtering failed/)).toBeTruthy();
	expect(screen.getByText("Last successful check: none yet")).toBeTruthy();
});

test("reports unsaved edits and clears them after saving", async () => {
	mockApi({ "GET /filters": { rules: two, enabled: true }, "PUT /filters": { ruleCount: 2, enabled: true } });
	const onDirtyChange = vi.fn();
	render(<FiltersTab mailbox="me@x.io" folders={folders} onDirtyChange={onDirtyChange} />);
	await screen.findByDisplayValue("invoice");
	expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	fireEvent.change(screen.getByLabelText("Rule 1: text to match"), { target: { value: "bill" } });
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
	fireEvent.click(screen.getByText("Save"));
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

test("delete all asks for confirmation first", async () => {
	const calls = mockApi({ "GET /filters": { rules: two, enabled: true }, "DELETE /filters": { removed: true } });
	render(<FiltersTab mailbox="me@x.io" folders={folders} />);
	await screen.findByDisplayValue("invoice");
	fireEvent.click(screen.getByText("Delete all"));
	const dialog = screen.getByRole("alertdialog");
	fireEvent.click(within(dialog).getByText("Cancel"));
	expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	fireEvent.click(screen.getByText("Delete all"));
	fireEvent.click(screen.getByRole("button", { name: "Delete all filters" }));
	await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
});

test("focus returns to Add filter after deleting all, and a new folder can go back to the list", async () => {
	mockApi({ "GET /filters": { rules: two, enabled: true }, "DELETE /filters": { removed: true } });
	render(<FiltersTab mailbox="me@x.io" folders={folders} />);
	await screen.findByDisplayValue("invoice");
	fireEvent.change(screen.getByLabelText("Rule 1: destination folder"), { target: { value: "\0new" } });
	fireEvent.click(screen.getByRole("button", { name: "Pick existing folder" }));
	expect(screen.getByLabelText("Rule 1: destination folder")).toBeTruthy();
	fireEvent.click(screen.getByText("Delete all"));
	fireEvent.click(screen.getByRole("button", { name: "Delete all filters" }));
	await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Add filter").closest("button")));
});

test("shows when the fallback last checked successfully", async () => {
	const lastCheck = Date.UTC(2026, 9, 29, 12, 0, 0);
	mockApi({ "GET /filters": { mode: "imap", rules: [], enabled: true, lastCheck } });
	render(<FiltersTab mailbox="me@x.io" />);
	expect(await screen.findByText(`Last successful check: ${new Date(lastCheck).toLocaleString()}`)).toBeTruthy();
});
