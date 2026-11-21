import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import CopyButton, { copyText } from "./CopyButton.jsx";

const original = { clipboard: navigator.clipboard, secure: window.isSecureContext };

function setClipboard(writeText, secure = true) {
	Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });
	Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
}

afterEach(() => {
	Object.defineProperty(navigator, "clipboard", { value: original.clipboard, configurable: true });
	Object.defineProperty(window, "isSecureContext", { value: original.secure, configurable: true });
	vi.useRealTimers();
});

describe("CopyButton", () => {
	test("copies the address and shows a check, then resets", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard(writeText);
		render(<CopyButton value="a.very.long.address@example.com" />);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy email address" })));
		expect(writeText).toHaveBeenCalledWith("a.very.long.address@example.com");
		expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
		act(() => vi.advanceTimersByTime(1600));
		expect(screen.getByRole("button", { name: "Copy email address" })).toBeTruthy();
	});

	test("reports a failed copy", async () => {
		setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
		render(<CopyButton value="x@example.com" />);
		await act(async () => fireEvent.click(screen.getByRole("button")));
		expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy();
	});

	test("renders nothing without a value", () => {
		const { container } = render(<CopyButton value="" />);
		expect(container.innerHTML).toBe("");
	});

	test("falls back to execCommand outside a secure context", async () => {
		setClipboard(undefined, false);
		document.execCommand = vi.fn().mockReturnValue(true);
		await copyText("lan@example.com");
		expect(document.execCommand).toHaveBeenCalledWith("copy");
		expect(document.querySelector("textarea")).toBeNull();
	});
});
