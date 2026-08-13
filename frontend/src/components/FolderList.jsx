import { Inbox, Send, Star, Archive, Trash2, Folder } from "lucide-react";

const SPECIAL_ICONS = {
	Inbox,
	Sent: Send,
	Starred: Star,
	Archive,
	Trash: Trash2,
};

export default function FolderList({ folders, active, onSelect }) {
	return (
		<nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
			{folders.length === 0 && (
				<div className="px-3 py-2 text-sm text-ink-faint">No folders</div>
			)}
			{folders.map((folder) => {
				const Icon = SPECIAL_ICONS[folder.name] || Folder;
				const isActive = folder.path === active;
				return (
					<button
						key={folder.path}
						onClick={() => onSelect(folder.path)}
						className={`relative flex w-full items-center gap-3 rounded-md pl-4 py-1.5 text-sm transition ${
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
					</button>
				);
			})}
		</nav>
	);
}