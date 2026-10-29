import { useCallback, useEffect, memo, useRef, useState } from "react";
import useSWR from "swr";
import { apiCall } from "../utils/apiCall.js";
import { isTypingTarget } from "../utils/keyboard.js";
import {
	Archive,
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Search,
	Star,
	Trash2,
} from "lucide-react";

const PAGE_SIZE = 50;
const SWIPE_TRIGGER = 80; // px left before release acts
const SWIPE_MAX = 120;

// Touch swipe-left on a row (mobile). Horizontal only — `touch-action:
// pan-y` leaves vertical scrolling to the browser. Returns the live offset
// and handlers; a completed swipe suppresses the click that follows.
function useSwipe(onSwipe) {
	const [dx, setDx] = useState(0);
	const start = useRef(null);
	const swiped = useRef(false);
	return {
		dx,
		swiped,
		handlers: onSwipe
			? {
					onTouchStart: (e) => {
						const t = e.touches[0];
						start.current = { x: t.clientX, y: t.clientY, horizontal: null };
						swiped.current = false;
					},
					onTouchMove: (e) => {
						const s = start.current;
						if (!s) return;
						const t = e.touches[0];
						const mx = t.clientX - s.x;
						const my = t.clientY - s.y;
						if (s.horizontal === null && Math.hypot(mx, my) > 10)
							s.horizontal = Math.abs(mx) > Math.abs(my);
						if (s.horizontal) setDx(Math.max(-SWIPE_MAX, Math.min(0, mx)));
					},
					onTouchEnd: () => {
						if (start.current?.horizontal && dx <= -SWIPE_TRIGGER) {
							swiped.current = true;
							onSwipe();
						}
						start.current = null;
						setDx(0);
					},
				}
			: {},
	};
}

const MessageRow = memo(function MessageRow({
	msg,
	isReading,
	isCursor,
	selected,
	onToggle,
	onClick,
	alwaysRead,
	swipe, // { label: "Archive" | "Delete", onSwipe } — mobile swipe-left
}) {
	const isUnread = !alwaysRead && !msg.seen;
	const isFlagged = msg.flags?.includes("\\Flagged");
	const { dx, swiped, handlers } = useSwipe(swipe?.onSwipe);
	const SwipeIcon = swipe?.label === "Archive" ? Archive : Trash2;

	return (
		<div className="relative overflow-hidden border-b border-hair">
			{dx < 0 && (
				<div
					aria-hidden
					className={`absolute inset-0 flex items-center justify-end gap-2 px-5 text-sm font-medium text-white ${
						swipe.label === "Archive" ? "bg-accent" : "bg-danger"
					} ${dx <= -SWIPE_TRIGGER ? "" : "opacity-60"}`}
				>
					<SwipeIcon className="h-4 w-4" />
					{swipe.label}
				</div>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: row click opens; keyboard via MessageList */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled globally */}
			<div
				onClick={(e) => {
					if (swiped.current) {
						swiped.current = false;
						e.preventDefault();
						return;
					}
					onClick(e);
				}}
				{...handlers}
				data-uid={msg.uid}
				style={{
					transform: dx ? `translateX(${dx}px)` : undefined,
					touchAction: "pan-y",
				}}
				className={`group relative flex w-full items-center gap-3 bg-canvas px-4 py-3 text-left ${
					dx ? "" : "transition"
				} hover:bg-hover/40 ${selected ? "bg-accent/10 font-bold" : ""} ${
					isReading === msg.uid ? "bg-accent/30" : ""
				} ${isCursor ? "shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
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

				{/* Flagged Star Icon */}
				{isFlagged && (
					<Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-400" />
				)}

				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-3 text-left"
				>
					<div className={`min-w-0 flex-1 ${selected ? "bg-red" : ""}`}>
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
		</div>
	);
});

function formatDate(date) {
	if (!date) return "";
	const d = new Date(date);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" });
}

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
	onToggleAll,
	onOpenMessage,
	alwaysRead = false,
	onReady,
	onMarkedRead,
	onSelectionChange,
	keyboardEnabled = true,
	refreshInterval = 10000,
	swipeAction, // { label, onSwipe(msg) } or undefined
}) {
	const [sort, setSort] = useState("desc");
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const [isReading, setIsReading] = useState("");
	const selectAllRef = useRef(null);
	const listRef = useRef(null);
	// Keyboard cursor row (follows clicks). anchorRef holds the Shift-range
	// origin and the selection that existed before the range started.
	const [cursor, setCursor] = useState(null);
	const anchorRef = useRef(null);

	const { data, isValidating, error, mutate } = useSWR(
		activeFolder ? listKey(activeFolder, page, sort, search) : null,
		fetcher,
		{ revalidateOnFocus: false, refreshInterval },
	);

	const messages = data?.messages || [];
	const total = data?.total || 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	// "Select all" covers every mail currently on the page (the observable
	// list the user sees). checked is TRUE only when every listed UID is
	// selected; indeterminate when the selection is partial; the tooltip shows
	// the count so selecting a large visible list is never a surprise.
	const visibleUids = messages.map((m) => m.uid);
	const allSelected =
		visibleUids.length > 0 && visibleUids.every((uid) => selected.has(uid));
	const someSelected =
		!allSelected && visibleUids.some((uid) => selected.has(uid));
	useEffect(() => {
		if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
	}, [someSelected]);

	// Reset to page 1 when folder / sort / search changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: later
	useEffect(() => {
		setPage(1);
	}, [activeFolder, sort, search]);

	const refresh = useCallback(() => mutate(), [mutate]);

	// Expose mutate() + loading + pagination to the parent (MailPage) so it can
	// refresh after mutations and render a fixed bottom pagination bar.
	useEffect(() => {
		if (onReady)
			onReady({ refresh, isValidating, page, setPage, total, totalPages });
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
					.then((res) => {
						if (onMarkedRead) onMarkedRead(res.data?.inboxUnseen);
						mutate();
					})
					.catch(() => {});
			}
			setCursor(msg.uid);
			anchorRef.current = null;
			if (onOpenMessage) {
				onOpenMessage(msg);
				setIsReading(msg.uid);
			}
		},
		[activeFolder, alwaysRead, onOpenMessage, onMarkedRead, mutate],
	);

	// ---- keyboard navigation ----
	// ↑/↓ j/k PgUp/PgDn Home/End move the cursor and open that message.
	// With Shift they extend a range selection instead (no open).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on view change
	useEffect(() => {
		setCursor(null);
		anchorRef.current = null;
	}, [activeFolder, page, sort, search]);

	useEffect(() => {
		if (!selected?.size) anchorRef.current = null;
	}, [selected]);

	useEffect(() => {
		if (cursor == null) return;
		listRef.current
			?.querySelector(`[data-uid="${cursor}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	useEffect(() => {
		if (!keyboardEnabled) return;
		// Rows that fit in the viewport, minus one for overlap.
		const pageStep = () => {
			const box = listRef.current;
			const rowH = box?.querySelector("[data-uid]")?.offsetHeight;
			return rowH ? Math.max(1, Math.floor(box.clientHeight / rowH) - 1) : 10;
		};
		const onKey = (e) => {
			if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
			if (isTypingTarget(e.target) || !messages.length) return;
			const idx = messages.findIndex((m) => m.uid === cursor);
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
			let next;
			switch (key) {
				case "ArrowDown":
				case "j":
					next = idx + 1;
					break;
				case "ArrowUp":
				case "k":
					next = idx < 0 ? 0 : idx - 1;
					break;
				case "PageDown":
					next = idx + pageStep();
					break;
				case "PageUp":
					next = idx - pageStep();
					break;
				case "Home":
					next = 0;
					break;
				case "End":
					next = messages.length - 1;
					break;
				case "Enter":
				case "o":
					if (idx < 0 || e.target.closest?.("button, a")) return;
					e.preventDefault();
					openMessage(messages[idx]);
					return;
				case "x":
					if (idx < 0) return;
					e.preventDefault();
					onToggleSelect(messages[idx].uid);
					return;
				default:
					return;
			}
			e.preventDefault();
			next = Math.max(0, Math.min(messages.length - 1, next));
			const target = messages[next];
			if (!e.shiftKey) {
				openMessage(target);
				return;
			}
			setCursor(target.uid);
			if (!anchorRef.current) {
				anchorRef.current = {
					uid: idx < 0 ? target.uid : messages[idx].uid,
					base: new Set(selected),
				};
			}
			const a = Math.max(
				0,
				messages.findIndex((m) => m.uid === anchorRef.current.uid),
			);
			const range = messages
				.slice(Math.min(a, next), Math.max(a, next) + 1)
				.map((m) => m.uid);
			onSelectionChange?.(new Set([...anchorRef.current.base, ...range]));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		keyboardEnabled,
		messages,
		cursor,
		selected,
		openMessage,
		onToggleSelect,
		onSelectionChange,
	]);

	return (
		<div className="flex h-full flex-col">
			{/* Search + sort toolbar */}
			<div className="flex items-center gap-2 border-b border-hair px-3 py-2">
				{/* Select all mails currently visible in the list (left of search) */}
				<input
					ref={selectAllRef}
					type="checkbox"
					checked={allSelected}
					aria-label="Select all visible mail"
					title={`${someSelected && !allSelected ? "Some" : allSelected ? "All" : "None"} of ${visibleUids.length} visible selected — click to ${allSelected ? "clear" : "select all"}`}
					onChange={() => onToggleAll(visibleUids)}
					className="h-4 w-4 shrink-0 cursor-pointer rounded border-hair-strong accent-accent"
				/>
				<div className="relative flex-1">
					<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
					<input
						id="mail-search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
						placeholder="Search mail…"
						className="w-full rounded-md border border-hair bg-panel/60 py-1.5 pl-8 pr-3 text-sm text-ink-2 outline-none transition placeholder:text-ink-faint focus:border-indigo-600"
					/>
				</div>
				<button
					type="button"
					onClick={() => setSort(sort === "desc" ? "asc" : "desc")}
					title={`Sort by arrival: ${sort === "desc" ? "Newest first" : "Oldest first"}`}
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
			<div ref={listRef} className="flex-1 overflow-y-auto">
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
						isCursor={cursor === msg.uid}
						selected={selected?.has(msg.uid)}
						onToggle={() => onToggleSelect(msg.uid)}
						onClick={() => openMessage(msg)}
						alwaysRead={alwaysRead}
						swipe={
							swipeAction && {
								label: swipeAction.label,
								onSwipe: () => swipeAction.onSwipe(msg),
							}
						}
					/>
				))}
			</div>
		</div>
	);
}
