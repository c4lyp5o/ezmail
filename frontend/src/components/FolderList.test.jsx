import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import FolderList from "./FolderList.jsx";

const folders = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", unread: 2 }];

test("creates a folder from the inline form", async () => {
	const onCreate = vi.fn().mockResolvedValue();
	render(<FolderList folders={folders} active="INBOX" onSelect={() => {}} onCreate={onCreate} />);
	fireEvent.click(screen.getByRole("button", { name: "New folder" }));
	fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "  Finance " } });
	fireEvent.click(screen.getByRole("button", { name: "Create" }));
	await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Finance"));
	await waitFor(() => expect(screen.queryByLabelText("New folder name")).toBeNull());
	expect(screen.getByRole("button", { name: "New folder" })).toBeTruthy();
});

test("shows the server's message and keeps the form open when creation fails", async () => {
	const onCreate = vi.fn().mockRejectedValue(new Error("A folder with that name already exists."));
	render(<FolderList folders={folders} active="INBOX" onSelect={() => {}} onCreate={onCreate} />);
	fireEvent.click(screen.getByRole("button", { name: "New folder" }));
	fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "Archive" } });
	fireEvent.submit(screen.getByLabelText("New folder name").closest("form"));
	expect((await screen.findByRole("alert")).textContent).toContain("already exists");
	expect(screen.getByLabelText("New folder name").value).toBe("Archive");
	fireEvent.keyDown(screen.getByLabelText("New folder name"), { key: "Escape" });
	expect(screen.queryByLabelText("New folder name")).toBeNull();
});

test("hides the control when no handler is provided", () => {
	render(<FolderList folders={folders} active="INBOX" onSelect={() => {}} />);
	expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
});

test("folders highlight and accept only ezmail message drags", async () => {
	const { createEvent } = await import("@testing-library/react");
	const onDrop = vi.fn();
	const two = [...folders, { path: "Archive", name: "Archive", specialUse: "\\Archive" }];
	render(<FolderList folders={two} active="INBOX" onSelect={() => {}} onDropMessages={onDrop} />);
	const target = screen.getByRole("button", { name: "Archive" });
	const fire = (type, data) => {
		const ev = createEvent[type](target);
		Object.defineProperty(ev, "dataTransfer", {
			value: { types: Object.keys(data), getData: (t) => data[t] || "", dropEffect: "" },
		});
		fireEvent(target, ev);
		return ev.defaultPrevented;
	};
	expect(fire("dragOver", { "text/plain": "x" })).toBe(false);
	expect(target.className).not.toContain("ring-accent");
	const payload = { "application/x-ezmail-uids": JSON.stringify({ uids: [5, "x", -1, 7], folder: "INBOX" }) };
	expect(fire("dragOver", payload)).toBe(true);
	expect(target.className).toContain("ring-accent");
	fire("drop", payload);
	expect(onDrop).toHaveBeenCalledWith("Archive", [5, 7], "INBOX");
	expect(target.className).not.toContain("ring-accent");
});
