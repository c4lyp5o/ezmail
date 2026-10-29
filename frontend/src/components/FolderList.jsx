import {
	Archive,
	FileText,
	Folder,
	Inbox,
	OctagonAlert,
	Plus,
	Send,
	Star,
	Trash2,
} from "lucide-react";
import { useState } from "react";

// Icons by RFC 6154 special-use flag; names are only a fallback.
const SPECIAL_USE_ICONS = {
	"\\Inbox": Inbox,
	"\\Sent": Send,
	"\\Flagged": Star,
	"\\Archive": Archive,
	"\\Trash": Trash2,
	"\\Drafts": FileText,
	"\\Junk": OctagonAlert,
};
const NAME_ICONS = {
	INBOX: Inbox,
	Inbox,
	Sent: Send,
	Starred: Star,
	Archive,
	Trash: Trash2,
	Drafts: FileText,
	Junk: OctagonAlert,
	Spam: OctagonAlert,
};

// Inline "New folder" form. onCreate(name) rejects with a user-facing message.
function NewFolder({ onCreate }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const close = () => { setOpen(false); setName(""); setError(""); };
	const submit = async (event) => {
		event.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		setError("");
		try { await onCreate(name.trim()); close(); }
		catch (err) { setError(err.message || "Could not create the folder."); }
		finally { setBusy(false); }
	};

	if (!open) {
		return (
			<button type="button" onClick={() => setOpen(true)} className="mt-1 flex w-full items-center gap-3 rounded-md py-1.5 pl-6 text-sm text-ink-muted transition hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
				<Plus className="h-4 w-4 shrink-0 text-ink-faint" />
				New folder
			</button>
		);
	}
	return (
		<form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }} className="mt-1 space-y-1.5 px-3 py-1.5">
			<input
				// biome-ignore lint/a11y/noAutofocus: the field appears in response to the user's click
				autoFocus
				value={name}
				onChange={(e) => setName(e.target.value)}
				aria-label="New folder name"
				aria-invalid={!!error}
				placeholder="Folder name"
				maxLength={64}
				className="min-h-10 w-full rounded-lg border border-hair bg-canvas px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none md:min-h-0"
			/>
			{error && <p role="alert" className="text-xs text-danger">{error}</p>}
			<div className="flex gap-2">
				<button type="submit" disabled={busy || !name.trim()} className="min-h-10 rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50 md:min-h-0">{busy ? "Creating…" : "Create"}</button>
				<button type="button" onClick={close} className="min-h-10 rounded-lg px-3 py-1 text-xs text-ink-muted hover:bg-hover md:min-h-0">Cancel</button>
			</div>
		</form>
	);
}

export default function FolderList({ folders, active, onSelect, onCreate }) {
	return (
		<nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
			{folders.length === 0 && (
				<div className="px-3 py-2 text-sm text-ink-faint">No folders</div>
			)}
			{folders.map((folder) => {
				const Icon =
					SPECIAL_USE_ICONS[folder.specialUse] || NAME_ICONS[folder.name] || Folder;
				const isActive = folder.path === active;
				// Unread counts are noise for Sent/Drafts/Trash.
				const unread = /\\(Sent|Drafts|Trash)/.test(folder.specialUse || "")
					? 0
					: folder.unread || 0;
				return (
					<button
						type="button"
						key={folder.path}
						onClick={() => onSelect(folder.path)}
						className={`relative flex w-full items-center gap-3 rounded-md pl-6 py-1.5 text-sm transition ${
							isActive
								? "bg-accent/12 text-ink font-medium"
								: "text-ink-muted hover:bg-hover hover:text-ink"
						}`}
					>
						{isActive && (
							<span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
						)}
						<Icon
							className={`h-4 w-4 shrink-0 ${
								isActive ? "text-accent" : "text-ink-faint"
							}`}
						/>
						<span className="truncate">{folder.name}</span>
						{unread > 0 && (
							<span
								className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
								title={`${unread} unread`}
							>
								{unread > 99 ? "99+" : unread}
							</span>
						)}
					</button>
				);
			})}
			{onCreate && <NewFolder onCreate={onCreate} />}
		</nav>
	);
}
