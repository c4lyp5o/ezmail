import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ConfirmPanel from "./ConfirmPanel.jsx";

// "…" button on a user folder row: a two-item menu (Rename, Delete). Delete
// confirms first; onDelete rejects with the server's message (e.g. 409 when
// the folder isn't empty), which stays in the confirmation.
export function FolderMenu({ folder, onRename, onDelete }) {
	const [open, setOpen] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState("");
	const busy = useRef(false);
	const wrapRef = useRef(null);
	const buttonRef = useRef(null);
	const menuRef = useRef(null);
	const items = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];

	useEffect(() => {
		if (!open) return;
		menuRef.current?.querySelector('[role="menuitem"]')?.focus();
		const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const closeMenu = () => { setOpen(false); buttonRef.current?.focus(); };
	const onMenuKey = (e) => {
		const list = items();
		const i = list.indexOf(document.activeElement);
		e.stopPropagation(); // list shortcuts (arrows, j/k) stay out of the menu
		if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
		else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
		else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
		else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
		else if (e.key === "End") { e.preventDefault(); list.at(-1)?.focus(); }
		else if (e.key === "Tab") setOpen(false);
	};
	// Focus goes back to the trigger first so dialogs restore it on close.
	const pick = (fn) => () => { closeMenu(); fn(); };
	const confirmDelete = async () => {
		if (busy.current) return;
		busy.current = true;
		setError("");
		try { await onDelete(folder.path); setConfirming(false); }
		catch (err) { setError(err.message || "Could not delete the folder."); }
		finally { busy.current = false; }
	};

	return (
		<div ref={wrapRef} className="absolute right-1 top-1/2 -translate-y-1/2">
			<button
				ref={buttonRef}
				type="button"
				draggable={false}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
				aria-label={`Folder actions for ${folder.name}`}
				aria-haspopup="menu"
				aria-expanded={open}
				title="Folder actions"
				className={`flex h-6 w-6 items-center justify-center rounded text-ink-muted transition hover:bg-hover hover:text-ink focus:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}
			>
				<MoreHorizontal className="h-4 w-4" />
			</button>
			{open && (
				<div
					ref={menuRef}
					role="menu"
					aria-label={`${folder.name} actions`}
					tabIndex={-1}
					onKeyDown={onMenuKey}
					className="absolute right-0 top-full z-30 mt-1 w-32 rounded-lg border border-hair-strong bg-panel py-1 text-sm shadow-xl"
				>
					<button type="button" role="menuitem" tabIndex={-1} onClick={pick(onRename)} className="block w-full px-3 py-1.5 text-left text-ink-2 hover:bg-hover focus:bg-hover focus:outline-none">Rename</button>
					<button type="button" role="menuitem" tabIndex={-1} onClick={pick(() => { setError(""); setConfirming(true); })} className="block w-full px-3 py-1.5 text-left text-danger hover:bg-danger/10 focus:bg-danger/10 focus:outline-none">Delete</button>
				</div>
			)}
			{confirming && createPortal(
				// Stops the native event at the portal's container so the window-level
				// shortcuts (#, e, c, j/k) can't fire behind the dialog.
				// biome-ignore lint/a11y/noStaticElementInteractions: not interactive; it only keeps keys inside the dialog
				<div onKeyDown={(e) => e.stopPropagation()}>
					<ConfirmPanel title="Delete folder?" confirmLabel="Delete folder" onConfirm={confirmDelete} onCancel={() => setConfirming(false)}>
						<p>Delete “{folder.name}”? Only empty folders can be deleted; move or delete its messages first.</p>
						{error && <p role="alert" className="mt-2 text-danger">{error}</p>}
					</ConfirmPanel>
				</div>,
				document.body,
			)}
		</div>
	);
}

// Inline rename form, modelled on "New folder". onSubmit(name) rejects with
// a user-facing message, shown under the field.
export function RenameFolder({ folder, onSubmit, onClose }) {
	const [name, setName] = useState(folder.name);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const trimmed = name.trim();

	const submit = async (event) => {
		event.preventDefault();
		if (!trimmed || trimmed === folder.name || busy) return;
		setBusy(true);
		setError("");
		try { await onSubmit(trimmed); onClose(); }
		catch (err) { setError(err.message || "Could not rename the folder."); setBusy(false); }
	};

	return (
		<form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} className="space-y-1.5 px-3 py-1.5">
			<input
				// biome-ignore lint/a11y/noAutofocus: the field appears in response to the user's click
				autoFocus
				onFocus={(e) => e.currentTarget.select()}
				value={name}
				onChange={(e) => setName(e.target.value)}
				aria-label={`New name for ${folder.name}`}
				aria-invalid={!!error}
				placeholder="Folder name"
				maxLength={64}
				className="min-h-10 w-full rounded-lg border border-hair bg-canvas px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none md:min-h-0"
			/>
			{error && <p role="alert" className="text-xs text-danger">{error}</p>}
			<div className="flex gap-2">
				<button type="submit" disabled={busy || !trimmed || trimmed === folder.name} className="min-h-10 rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50 md:min-h-0">{busy ? "Renaming…" : "Rename"}</button>
				<button type="button" onClick={onClose} className="min-h-10 rounded-lg px-3 py-1 text-xs text-ink-muted hover:bg-hover md:min-h-0">Cancel</button>
			</div>
		</form>
	);
}
