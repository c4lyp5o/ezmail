import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { ThemeProvider } from "../context/theme.jsx";
import { mockApi } from "../test/fetch.js";
import SettingsModal from "./SettingsModal.jsx";

function Harness({ onToggleNotify = () => {} }) {
	const [open, setOpen] = useState(false);
	return <ThemeProvider><button type="button" onClick={() => setOpen(true)}>Open settings</button><SettingsModal open={open} onClose={() => setOpen(false)} mailbox="me@example.com" onToggleNotify={onToggleNotify} /></ThemeProvider>;
}

test("opens settings and navigates between sidebar sections", async () => {
	mockApi({
		"GET /profile": { displayName: "Ada" },
		"POST /totp/status": { enabled: false, enrolled: false },
		"GET /filters": { enabled: false, rules: [] },
	});
	const toggleNotify = vi.fn();
	render(<Harness onToggleNotify={toggleNotify} />);
	screen.getByText("Open settings").focus();
	fireEvent.click(screen.getByText("Open settings"));
	const dialog = screen.getByRole("dialog", { name: "Settings" });
	expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Desktop notifications" }));
	expect(toggleNotify).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole("button", { name: "Profile" }));
	expect(await screen.findByDisplayValue("Ada")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Security" }));
	expect(await screen.findByText(/Turn on passwordless login/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Filters" }));
	expect(await screen.findByText(/No filters yet/)).toBeTruthy();
	fireEvent.keyDown(dialog, { key: "Escape" });
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(document.activeElement).toBe(screen.getByText("Open settings"));
});

test("warns before closing or switching away from unsaved filter edits", async () => {
	mockApi({ "GET /filters": { enabled: true, rules: [{ field: "subject", match: "contains", value: "a", folder: "X" }] }, "GET /profile": { displayName: "Ada" } });
	render(<Harness />);
	fireEvent.click(screen.getByText("Open settings"));
	fireEvent.click(screen.getByRole("button", { name: "Filters" }));
	fireEvent.change(await screen.findByLabelText("Rule 1: text to match"), { target: { value: "b" } });
	await screen.findByText("You have unsaved changes.");
	fireEvent.click(screen.getByRole("button", { name: "Profile" }));
	expect(screen.getByRole("alertdialog")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
	expect(screen.getByLabelText("Rule 1: text to match").value).toBe("b");
	fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
	fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
	fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
	expect(screen.queryByRole("dialog")).toBeNull();
});
