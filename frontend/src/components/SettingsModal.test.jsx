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
