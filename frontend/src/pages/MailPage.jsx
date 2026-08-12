import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { apiCall } from "../utils/apiCall.js";
import { useAuth } from "../context/auth.jsx";
import FolderList from "../components/FolderList.jsx";
import MessageList from "../components/MessageList.jsx";
import MessageView from "../components/MessageView.jsx";
import ComposeView from "../components/ComposeView.jsx";
import SummaryColumn from "../components/SummaryColumn.jsx";
import {
	Inbox,
	LogOut,
	PenSquare,
	Trash2,
	CheckCheck,
	FolderInput,
	X,
	ChevronLeft,
	ChevronRight,
	Menu,
} from "lucide-react";

// Builds a compact page-number list with ellipses, e.g.
// [1, 2, 3, "…", 50] for page 2 of 50; [1, "…", 5, 6, 7, "…", 50] for middle pages.
function pageNumbers(total, current) {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
	const pages = new Set([1, total, current - 1, current, current + 1]);
	const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
	const withEllipses = [];
	let prev = 0;
	for (const p of sorted) {
		if (prev && p - prev > 1) withEllipses.push("…");
		withEllipses.push(p);
		prev = p;
	}
	return withEllipses;
}

export default function MailPage() {
	const { user, logout } = useAuth();
	const navigate = useNavigate();
	const [folders, setFolders] = useState([]);
	const [activeFolder, setActiveFolder] = useState("INBOX");
	const [view, setView] = useState({ type: "folder" }); // {type:'folder'} | {type:'message', folder, uid, msg} | {type:'compose'}
	const [selected, setSelected] = useState(() => new Set()); // Set of UIDs, persists across opens
	const [movePopup, setMovePopup] = useState(false);
	const [bulkBusy, setBulkBusy] = useState(false);

	// Mobile: sidebar drawer open state + which pane is shown
	const [mobileSidebar, setMobileSidebar] = useState(false);
	const [mobilePane, setMobilePane] = useState("list"); // "list" | "reader"

	// Track viewport size so the resizable list column only applies on desktop.
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 767px)");
		const onChange = (e) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// Growable message-list column width (drag the separator edge).
	const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem("ezmail_list_width")) || 320);
	const [isDraggingList, setIsDraggingList] = useState(false);
	// Records where the drag began so the width tracks the mouse 1:1 without a
	// jump (the grab handle sits ~6px past the column's right edge).
	const dragStartRef = useRef({ width: 0, x: 0 });

	const onListDragStart = useCallback(
		(e) => {
			dragStartRef.current = { width: listWidth, x: e.clientX };
			setIsDraggingList(true);
		},
		[listWidth],
	);

	useEffect(() => {
		const handleMouseMove = (e) => {
			if (!isDraggingList) return;
			const { width, x } = dragStartRef.current;
			// apply the delta from grab point, then clamp so the reader keeps room
			const next = width + (e.clientX - x);
			setListWidth(Math.max(240, Math.min(next, window.innerWidth - 380)));
		};
		const handleMouseUp = () => {
			setIsDraggingList(false);
		};
		if (isDraggingList) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
		} else {
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		}
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
	}, [isDraggingList]);

	// Persist the width so it survives reloads.
	useEffect(() => {
		try {
			localStorage.setItem("ezmail_list_width", String(Math.round(listWidth)));
		} catch {
			// localStorage may be unavailable; non-fatal
		}
	}, [listWidth]);
	const [listState, setListState] = useState({
		refresh: null,
		isValidating: false,
		page: 1,
		setPage: null,
		total: 0,
		totalPages: 1,
	});
	const {
		refresh: refreshList,
		isValidating: listIsValidating,
		page: listPage,
		setPage: setListPage,
		total: listTotal,
		totalPages,
	} = listState;

	const llmPresent = !!user?.llmPresent;

	const loadFolders = useCallback(async () => {
		try {
			const res = await apiCall.get("/mail/folders");
			setFolders(res.data || []);
		} catch {
			// folders stay empty; list drives UI
		}
	}, []);

	useEffect(() => {
		loadFolders();
	}, [loadFolders]);

	// On login, default to INBOX folder view
	useEffect(() => {
		setView({ type: "folder" });
	}, [user?.mailbox]);

	const handleLogout = async () => {
		await logout();
		navigate("/login", { replace: true });
	};

	// ---- selection helpers ----
	const toggleSelect = useCallback((uid) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(uid)) next.delete(uid);
			else next.add(uid);
			return next;
		});
	}, []);

	const clearSelection = useCallback(() => setSelected(new Set()), []);
	const selectedUids = [...selected];

	// ---- bulk actions ----
	const bulkMarkRead = async () => {
		if (!selectedUids.length) return;
		setBulkBusy(true);
		try {
			await Promise.all(
				selectedUids.map((uid) =>
					apiCall
						.post("/mail/flags", { folder: activeFolder, uid, flags: ["\\Seen"] })
						.catch(() => {}),
				),
			);
			afterMutation();
		} finally {
			setBulkBusy(false);
		}
	};

	const bulkDelete = async () => {
		if (!selectedUids.length) return;
		setBulkBusy(true);
		try {
			await Promise.all(
				selectedUids.map((uid) =>
					apiCall
						.post("/mail/move", { uid, from: activeFolder, to: "Trash" })
						.catch(() => {}),
				),
			);
			afterMutation();
		} finally {
			setBulkBusy(false);
		}
	};

	const bulkMove = async (toFolder) => {
		if (!selectedUids.length) return;
		setMovePopup(false);
		setBulkBusy(true);
		try {
			await Promise.all(
				selectedUids.map((uid) =>
					apiCall
						.post("/mail/move", { uid, from: activeFolder, to: toFolder })
						.catch(() => {}),
				),
			);
			afterMutation();
		} finally {
			setBulkBusy(false);
		}
	};

	// ---- folder / message selection ----
	const selectFolder = (f) => {
		setActiveFolder(f);
		setView({ type: "folder" });
		setMobileSidebar(false);
		setMobilePane("list");
	};

	// Back from reader/compose: return to the folder grid (desktop) and to the
	// list pane on mobile.
	const handleBack = () => {
		setView({ type: "folder" });
		setMobilePane("list");
	};

	// After any mutation (mark read / delete / move), refresh the SWR list so
	// the UI reflects the server state (needed because moves change UIDs).
	const afterMutation = useCallback(() => {
		clearSelection();
		setView({ type: "folder" });
		if (refreshList) refreshList();
	}, [refreshList]);

	const openMessage = (folder, uid, msg) => {
		setView({ type: "message", folder, uid, msg });
	};

	// Fetch the full message body once when a message is opened, so both the
	// detail view AND the summary column get the real text/html (the list item
	// passed in has no body). Also refresh the list so the read state updates.
	const [fullMessage, setFullMessage] = useState(null);
	const openMessageWithBody = useCallback(
		async (folder, uid, msg) => {
			setView({ type: "message", folder, uid, msg });
			setMobilePane("reader");
			setMobileSidebar(false);
			try {
				const res = await apiCall.get(
					`/mail/message/${encodeURIComponent(folder)}/${uid}`,
				);
				setFullMessage({ ...(res.data || {}), folder });
			} catch {
				setFullMessage(null);
			}
		},
		[setView],
	);

	return (
		<div className="flex h-dvh w-full overflow-x-hidden bg-zinc-950 text-zinc-100">
			{/* Mobile: hamburger to open the sidebar drawer */}
			<button
				onClick={() => setMobileSidebar(true)}
				className="fixed left-3 top-1.5 z-30 flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 shadow-lg md:hidden"
				aria-label="Open folders"
			>
				<Menu className="h-4 w-4" />
			</button>

			{/* Sidebar */}
			<aside
				className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/95 backdrop-blur transition-transform duration-200 md:static md:translate-x-0 md:bg-zinc-900/60 ${
					mobileSidebar ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				{/* Close button on mobile */}
				<button
					onClick={() => setMobileSidebar(false)}
					className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 md:hidden"
					aria-label="Close folders"
				>
					<X className="h-4 w-4" />
				</button>
				<div className="flex items-center gap-2 px-4 py-4">
					<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
						<Inbox className="h-4 w-4" />
					</div>
					<span className="text-lg font-semibold">ezmail</span>
				</div>

				<button
					onClick={() => setView({ type: "compose" })}
					className="mx-3 mb-3 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
				>
					<PenSquare className="h-4 w-4" />
					Compose
				</button>

				<FolderList folders={folders} active={activeFolder} onSelect={selectFolder} />

				<div className="mt-auto border-t border-zinc-800 p-4">
					<div className="mb-2 truncate text-sm text-zinc-400">
						{user?.mailbox || "mailbox"}
					</div>
					<button
						onClick={handleLogout}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
					>
						<LogOut className="h-4 w-4" />
						Log out
					</button>
				</div>
			</aside>

			{/* Message list column — resizable on desktop, full-screen when selected on mobile */}
			<div
				style={isMobile ? undefined : { width: listWidth }}
				className={`relative shrink-0 flex-col border-r border-zinc-800 ${
					isMobile
						? mobilePane === "list"
							? "flex w-full max-w-full min-w-0"
							: "hidden"
						: "flex min-w-0"
				}`}
			>
				{/* Drag handle on the separator edge (desktop only) */}
				<div
					onMouseDown={onListDragStart}
					className="group absolute -right-1.5 top-0 z-50 hidden h-full w-3 cursor-col-resize justify-center md:flex"
				>
					<div
						className={`w-0.5 transition-colors ${
							isDraggingList
								? "bg-indigo-500"
								: "bg-transparent group-hover:bg-indigo-500/50"
						}`}
					/>
				</div>
				{/* Bulk action bar shown when selection exists */}
				{selectedUids.length > 0 ? (
					<div className="flex items-center gap-1 border-b border-zinc-800 bg-indigo-950/40 px-3 py-2">
						<span className="px-1 text-sm font-medium text-indigo-300">
							{selectedUids.length}
						</span>
						<div className="flex-1" />
						<button
							onClick={bulkMarkRead}
							disabled={bulkBusy}
							title="Mark as read"
							className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
						>
							<CheckCheck className="h-4 w-4" />
						</button>
						<button
							onClick={() => setMovePopup(true)}
							disabled={bulkBusy}
							title="Move to"
							className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
						>
							<FolderInput className="h-4 w-4" />
						</button>
						<button
							onClick={bulkDelete}
							disabled={bulkBusy}
							title="Delete"
							className="rounded-lg p-2 text-zinc-300 transition hover:bg-red-950 hover:text-red-400 disabled:opacity-50"
						>
							<Trash2 className="h-4 w-4" />
						</button>
						<button
							onClick={clearSelection}
							title="Clear selection"
							className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				) : (
							<div className="border-b border-zinc-800 py-3 pl-14 pr-4 md:pl-4">
							<div className="flex items-center gap-2">
							<h2 className="text-lg font-semibold capitalize">{activeFolder}</h2>
							{listIsValidating && (
								<div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-500" />
							)}
						</div>
					</div>
				)}

				<div className="flex min-h-0 flex-1 flex-col">
					{/* MessageList manages its own scroll */}
					<MessageList
						activeFolder={activeFolder}
						selected={selected}
						onToggleSelect={toggleSelect}
						onOpenMessage={(msg) => openMessageWithBody(activeFolder, msg.uid, msg)}
						alwaysRead={activeFolder === "Sent"}
						onReady={setListState}
					/>
				</div>

				{/* Fixed bottom pagination bar */}
				{totalPages > 1 && (
					<div className="flex items-center justify-center gap-1 border-t border-zinc-800 bg-zinc-900/60 px-3 py-2">
						<button
							onClick={() => setListPage?.(Math.max(1, listPage - 1))}
							disabled={listPage <= 1}
							className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-40"
							title="Previous page"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>
						{pageNumbers(totalPages, listPage).map((p, i) =>
							p === "…" ? (
								<span key={`e${i}`} className="px-1 text-zinc-600">
									…
								</span>
							) : (
								<button
									key={p}
									onClick={() => setListPage?.(p)}
									className={`min-w-7 rounded-md px-2 py-1 text-sm transition ${
										p === listPage
											? "bg-indigo-600 text-white"
											: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
									}`}
								>
									{p}
								</button>
							),
						)}
						<button
							onClick={() =>
								setListPage?.(Math.min(totalPages, listPage + 1))
							}
							disabled={listPage >= totalPages}
							className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-40"
							title="Next page"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
				)}
			</div>

			{/* Main content column */}
							<main
								className={`min-w-0 flex-1 ${isMobile && mobilePane === "list" ? "hidden" : ""}`}
							>
				{view.type === "compose" && (
					<ComposeView onBack={handleBack} />
				)}
				{view.type === "message" && (
					<MessageView
						folder={view.folder}
						uid={view.uid}
						initialMsg={view.msg}
						onBack={handleBack}
					/>
				)}
				{view.type === "folder" && (
					<div className="flex h-full items-center justify-center text-zinc-500">
						<Inbox className="mr-2 h-5 w-5" />
						Select a message to read it
					</div>
				)}
			</main>

			{/* Summary column when viewing a message with LLM present (hidden on
			    small screens — the reader stays full-width on mobile) */}
			{llmPresent && view.type === "message" && !isMobile && (
				<SummaryColumn
					message={fullMessage || view.msg}
					onClose={() => setView((v) => ({ ...v, summaryClosed: true }))}
				/>
			)}

			{/* Move-to popup */}
			{movePopup && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
					onClick={() => setMovePopup(false)}
				>
					<div
						className="w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
						onClick={(e) => e.stopPropagation()}
					>
						<h3 className="mb-3 text-sm font-semibold text-zinc-200">Move to</h3>
						<div className="max-h-72 space-y-1 overflow-y-auto">
							{folders
								.filter((f) => f.path !== activeFolder)
								.map((f) => (
									<button
										key={f.path}
										onClick={() => bulkMove(f.path)}
										disabled={bulkBusy}
										className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 transition hover:bg-zinc-800"
									>
										{f.name}
									</button>
								))}
						</div>
						<button
							onClick={() => setMovePopup(false)}
							className="mt-3 w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-400 transition hover:bg-zinc-800"
						>
							Cancel
						</button>
					</div>
				</div>
			)}
		</div>
	);
}