import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import FolderList from "./FolderList.jsx";

const folders = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", unread: 2 }];

test("folders named like Object.prototype members render as plain user folders", () => {
	const odd = ["constructor", "toString", "__proto__", "hasOwnProperty"].map((name) => ({ path: name, name, unread: 0 }));
	render(<FolderList folders={[...folders, ...odd]} active="INBOX" onSelect={() => {}} onRename={() => {}} onDelete={() => {}} />);
	for (const { name } of odd) {
		expect(screen.getByRole("button", { name })).toBeTruthy();
		expect(screen.getByRole("button", { name: `Folder actions for ${name}` })).toBeTruthy(); // user folder, not "system"
	}
});

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

describe("rename and delete", () => {
	const all = [
		{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
		{ path: "Sent", name: "Sent", specialUse: "\\Sent" },
		{ path: "Junk", name: "Junk" }, // special by name only
		{ path: "Projects", name: "Projects", delimiter: "/" },
	];
	const setup = (props = {}) => {
		const onRename = vi.fn().mockResolvedValue();
		const onDelete = vi.fn().mockResolvedValue();
		const onSelect = vi.fn();
		render(<FolderList folders={all} active="INBOX" onSelect={onSelect} onRename={onRename} onDelete={onDelete} {...props} />);
		return { onRename, onDelete, onSelect };
	};
	const menuButton = () => screen.getByRole("button", { name: "Folder actions for Projects" });

	test("only user folders get the menu", () => {
		setup();
		expect(screen.getAllByRole("button", { name: /^Folder actions for/ })).toHaveLength(1);
		expect(menuButton()).toBeTruthy();
	});

	test("no menu without both handlers", () => {
		render(<FolderList folders={all} active="INBOX" onSelect={() => {}} />);
		expect(screen.queryByRole("button", { name: /^Folder actions for/ })).toBeNull();
	});

	test("the menu is keyboard operable and does not select the folder", async () => {
		const { onSelect } = setup();
		fireEvent.keyDown(menuButton(), { key: "ArrowDown" });
		const items = await screen.findAllByRole("menuitem");
		expect(items.map((i) => i.textContent)).toEqual(["Rename", "Delete"]);
		await waitFor(() => expect(document.activeElement).toBe(items[0]));
		fireEvent.keyDown(items[0], { key: "ArrowDown" });
		expect(document.activeElement).toBe(items[1]);
		fireEvent.keyDown(items[1], { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(menuButton());
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("rename prefills the leaf name and shows the server's error inline", async () => {
		const { onRename } = setup();
		onRename.mockRejectedValueOnce(new Error("A folder with that name already exists."));
		fireEvent.click(menuButton());
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const input = screen.getByLabelText("New name for Projects");
		expect(input.value).toBe("Projects");
		expect(screen.getByRole("button", { name: "Rename" }).disabled).toBe(true);
		fireEvent.change(input, { target: { value: " Work " } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect((await screen.findByRole("alert")).textContent).toContain("already exists");
		expect(onRename).toHaveBeenCalledWith("Projects", "Work");
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		await waitFor(() => expect(screen.queryByLabelText("New name for Projects")).toBeNull());
	});

	test("delete confirms first and keeps the server's refusal visible", async () => {
		const { onDelete } = setup();
		onDelete.mockRejectedValueOnce(new Error("Only empty folders can be deleted."));
		fireEvent.click(menuButton());
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog.textContent).toContain("Only empty folders can be deleted");
		expect(onDelete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
		expect((await screen.findByRole("alert")).textContent).toBe("Only empty folders can be deleted.");
		expect(onDelete).toHaveBeenCalledWith("Projects");
		fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	test("a user folder row still accepts message drops", async () => {
		const { createEvent } = await import("@testing-library/react");
		const onDrop = vi.fn();
		setup({ onDropMessages: onDrop });
		const fire = (target, type) => {
			const ev = createEvent[type](target);
			const data = { "application/x-ezmail-uids": JSON.stringify({ uids: [3], folder: "INBOX" }) };
			Object.defineProperty(ev, "dataTransfer", { value: { types: Object.keys(data), getData: (t) => data[t] || "", dropEffect: "" } });
			fireEvent(target, ev);
		};
		fire(menuButton(), "drop");
		expect(onDrop).toHaveBeenCalledWith("Projects", [3], "INBOX");
		expect(menuButton().getAttribute("draggable")).toBe("false");
	});
});
