import { useCallback, useEffect, memo, useState } from "react";
import useSWR from "swr";
import { apiCall } from "../utils/apiCall.js";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from "lucide-react";

const PAGE_SIZE = 50;

const MessageRow = memo(function MessageRow({ msg, isReading, selected, onToggle, onClick, alwaysRead }) {
	const isUnread = !alwaysRead && !msg.seen;
	return (
		<div
			className={`group flex w-full items-center gap-3 border-b border-hair px-4 py-3 text-left transition hover:bg-hover/40 ${
				selected ? "bg-accent/10 font-bold" : ""
			} ${isReading === msg.uid ? "bg-accent/30" : ""}`}
		>
			<input
				type="checkbox"
				checked={!!selected}
				onChange={(e) => {
					e.stopPropagation();
					onToggle(msg.uid);
				}}
				onClick={(e) => e.stopPropagation()}
				className="h-4 w-4 shrink-0 cursor-pointer rounded border-hair-strong accent-accent"
			/>
			<button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left">
				<div className={`min-w-0 flex-1 ${selected ? 'bg-red' : ""}`}>
					<div
						className={`truncate text-sm ${
							isUnread ? "font-semibold text-ink" : "text-ink-muted"
						}`}
					>
						{msg.fromName || msg.from}
					</div>
					<div className="flex items-center gap-2">
						{isUnread && (
							<span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
						)}
						<div
							className={`truncate text-sm ${
								isUnread ? "text-ink-2" : "text-ink-muted"
							}`}
						>
							{msg.subject}
						</div>
					</div>
				</div>
				<div className="shrink-0 text-right">
					<div className="text-xs text-ink-muted">{formatDate(msg.date)}</div>
				</div>
			</button>
		</div>
	);
});

// Builds the SWR key for a given folder / page / sort / search.
const listKey = (folder, page, sort, search) =>
	`/mail/messages/${encodeURIComponent(folder)}?page=${page}&pageSize=${PAGE_SIZE}&sort=${sort}&search=${encodeURIComponent(search || "")}`;
const fetcher = async (url) => {
	const res = await apiCall.get(url);
	return res?.data || { messages: [], total: 0, page: 1, pageSize: PAGE_SIZE };
};

export default function MessageList({
	activeFolder,
	selected,
	onToggleSelect,
	onOpenMessage,
	alwaysRead = false,
	onReady,
}) {
	const [sort, setSort] = useState("desc");
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
  const [isReading, setIsReading] = useState("");

	const {
		data,
		isValidating,
		error,
		mutate,
	} = useSWR(
		activeFolder ? listKey(activeFolder, page, sort, search) : null,
		fetcher,
		{ revalidateOnFocus: false, refreshInterval: 10000 },
	);

	const messages = data?.messages || [];
	const total = data?.total || 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	// Reset to page 1 when folder / sort / search changes.
	useEffect(() => {
		setPage(1);
	}, [activeFolder, sort, search]);

	const refresh = useCallback(() => mutate(), [mutate]);

	// Expose mutate() + loading + pagination to the parent (MailPage) so it can
	// refresh after mutations and render a fixed bottom pagination bar.
	useEffect(() => {
		if (onReady) onReady({ refresh, isValidating, page, setPage, total, totalPages });
	}, [onReady, refresh, isValidating, page, total, totalPages]);

	const openMessage = useCallback(
		(msg) => {
			// Optimistically mark read in the local cache, then reflect on server.
			if (!alwaysRead && !msg.seen) {
				mutate(
					(data) => ({
						...data,
						messages: (data?.messages || []).map((m) =>
							m.uid === msg.uid ? { ...m, seen: true } : m,
						),
					}),
					false,
				);
				apiCall
					.post("/mail/flags", {
						folder: activeFolder,
						uids: [msg.uid],
            action: "add",
						flags: ["\\Seen"],
					})
					.then(() => mutate())
					.catch(() => {});
			}
			if (onOpenMessage) { onOpenMessage(msg); setIsReading(msg.uid); };
		},
		[activeFolder, alwaysRead, onOpenMessage, mutate],
	);

	return (
		<div className="flex h-full flex-col">
			{/* Search + sort toolbar */}
			<div className="flex items-center gap-2 border-b border-hair px-3 py-2">
				<div className="relative flex-1">
					<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search mail…"
						className="w-full rounded-md border border-hair bg-panel/60 py-1.5 pl-8 pr-3 text-sm text-ink-2 outline-none transition placeholder:text-ink-faint focus:border-indigo-600"
					/>
				</div>
				<button
					onClick={() => setSort(sort === "desc" ? "asc" : "desc")}
					title={`Sort by date: ${sort === "desc" ? "Newest first" : "Oldest first"}`}
					className="flex items-center gap-1 rounded-md border border-hair px-2 py-1.5 text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					{sort === "desc" ? (
						<ArrowDown className="h-3.5 w-3.5" />
					) : (
						<ArrowUp className="h-3.5 w-3.5" />
					)}
					<ArrowUpDown className="h-3.5 w-3.5" />
				</button>
			</div>

			{/* Message list */}
			<div className="flex-1 overflow-y-auto">
				{isValidating && !messages.length && (
					<div className="flex flex-col items-center gap-3 p-12 text-ink-muted">
						<div className="h-6 w-6 animate-spin rounded-full border-2 border-hair-strong border-t-indigo-500" />
						<span className="text-sm">Loading…</span>
					</div>
				)}
				{error && (
					<div className="m-4 rounded-lg border border-danger/20 bg-danger/10 p-4 text-sm text-danger">
						{error}
					</div>
				)}
				{!isValidating && !error && messages.length === 0 && (
					<div className="p-8 text-center text-ink-muted">
						{search ? "No messages match your search" : "No messages"}
					</div>
				)}

				{messages.map((msg) => (
					<MessageRow
						key={msg.uid}
						msg={msg}
            isReading={isReading}
						selected={selected?.has(msg.uid)}
						onToggle={() => onToggleSelect(msg.uid)}
						onClick={() => openMessage(msg)}
						alwaysRead={alwaysRead}
					/>
				))}
			</div>
		</div>
	);
}

function formatDate(date) {
	if (!date) return "";
	const d = new Date(date);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" });
}