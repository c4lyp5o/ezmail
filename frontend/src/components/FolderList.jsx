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
		<nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
			{folders.length === 0 && (
				<div className="px-3 py-2 text-sm text-zinc-600">No folders</div>
			)}
			{folders.map((folder) => {
				const Icon = SPECIAL_ICONS[folder.name] || Folder;
				const isActive = folder.path === active;
				return (
					<button
						key={folder.path}
						onClick={() => onSelect(folder.path)}
						className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
							isActive
								? "bg-indigo-600/15 text-indigo-300"
								: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						}`}
					>
						<Icon className="h-4 w-4 shrink-0" />
						<span className="truncate">{folder.name}</span>
					</button>
				);
			})}
		</nav>
	);
}