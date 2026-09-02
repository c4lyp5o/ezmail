import { Archive, Folder, Inbox, Send, Star, Trash2 } from "lucide-react";

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
				const unread = folder.path === "INBOX" ? folder.unread || 0 : 0;
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
		</nav>
	);
}
