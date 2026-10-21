import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { apiCall } from "../utils/apiCall.js";
import {
	ArrowLeft,
	Mail as MailIcon,
	Trash2,
	ChevronDown,
	ChevronRight,
	Paperclip,
	Download,
	FileWarning,
	Forward,
	Image as ImageIcon,
	Reply,
	ReplyAll,
} from "lucide-react";

function DetailRow({ label, value }) {
	return (
		<div className="flex gap-3">
			<span className="w-24 shrink-0 text-ink-muted">{label}</span>
			<span className="min-w-0 break-all text-ink-2">{value}</span>
		</div>
	);
}

function formatDate(date) {
	if (!date) return "";
	const d = new Date(date);
	const diffMs = Date.now() - d.getTime();
	if (diffMs >= 0 && diffMs < 60 * 1000) return "just now";
	if (diffMs >= 0 && diffMs < 3600 * 1000)
		return `${Math.max(1, Math.floor(diffMs / 60000))}m ago`;
	if (diffMs >= 0 && diffMs < 24 * 3600 * 1000)
		return `${Math.floor(diffMs / 3600000)}h ago`;
	if (diffMs >= 0 && diffMs < 7 * 24 * 3600 * 1000)
		return `${Math.floor(diffMs / 86400000)}d ago`;
	return d.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

// Heuristic: a plain-text body is treated as markdown when it contains common
// markdown signals (headings, lists, bold/italic, code fences, links).
function looksLikeMarkdown(text) {
	if (!text) return false;
	return /(?:^|\n)\s{0,3}#{1,6}\s|(?:^|\n)\s*[-*+]\s+|(?:^|\n)\s*\d+\.\s+|```|(\*\*|__).+?(\*\*|__)|\[[^\]]+\]\([^)]+\)/.test(
		text,
	);
}

export const attachmentUrl = (folder, uid, index) =>
	`/api/v1/mail/message/${encodeURIComponent(folder)}/${uid}/attachment/${index}`;

function formatBytes(bytes) {
	if (!bytes || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Wraps an email's HTML in a standalone document for the sandboxed iframe.
function emailDoc(html, showRemote) {
	return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
	body{margin:0;padding:0;display:flow-root;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#18181b;}
	img{max-width:100%;height:auto;}
	table{max-width:100%;border-collapse:collapse;}
	a{color:#3451b1;}
	/* Remote images stay hidden until the user opts in (privacy / tracking-safe). */
</style></head>
<body class="${showRemote ? "show-remote" : ""}">${prepareHtml(html, showRemote)}</body>
</html>`;
}

// Strip remote (<img src="http(s)://...">) image URLs until the user taps
// "Load remote images" — merely hiding them would still fetch them (tracking
// pixels). Same-origin/inline stay.
function prepareHtml(html, showRemote) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (!showRemote) {
		doc.querySelectorAll("img").forEach((img) => {
			const src = img.getAttribute("src") || "";
			if (/^(https?:)?\/\//i.test(src)) {
				img.setAttribute("data-remote-src", src);
				img.removeAttribute("src");
				img.removeAttribute("srcset");
			}
		});
	}
	// Ensure external links open in a new tab (sandbox allows popups to escape).
	doc.querySelectorAll("a[href]").forEach((a) => {
		if (/^(https?:|mailto:)/i.test(a.getAttribute("href") || "")) {
			a.target = "_blank";
			a.rel = "noopener noreferrer";
		}
	});
	return doc.body.innerHTML;
}

export default function MessageView({
	folder,
	uid,
	initialMsg,
	onBack,
	onDelete,
	onCompose,
	setShowRemote,
	showRemote,
	onLoaded,
}) {
	const [msg, setMsg] = useState(initialMsg || null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [showDetails, setShowDetails] = useState(false);

	// True when the loaded HTML contains externally-hosted images (http(s)://),
	// so we can offer a Gmail-style "Load remote images" button.
	const showRemoteButton = useMemo(() => {
		if (!msg?.html) return false;
		return /<img[^>]+src=["'](?:\/\/|https?:)?\/\//i.test(msg.html);
	}, [msg?.html]);

	const thisFolder = decodeURIComponent(folder || "INBOX");

	// Reset per-message UI (details panel, scroll) whenever a new message opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: later
	useEffect(() => {
		setShowDetails(false);
		setError("");
	}, [uid, thisFolder]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: later
	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const res = await apiCall.get(
				`/mail/message/${encodeURIComponent(thisFolder)}/${uid}`,
			);
			setShowRemote(false);
			setMsg(res.data || null);
			onLoaded?.(res.data ? { ...res.data, folder: thisFolder } : null);
		} catch (err) {
			setError(err.message || "Failed to load message");
			if (!initialMsg) setMsg(null);
		} finally {
			setLoading(false);
		}
	}, [thisFolder, uid, initialMsg, onLoaded]);

	// Always fetch the full message (the list item is only an optimistic
	// placeholder — it lacks the body/html/text). Without this, the detail
	// view would show "(no body)".
	useEffect(() => {
		load();
	}, [load]);

	// Inline (cid:) images render in the body; only real files get cards.
	const files = (msg?.attachments || []).filter((a) => !a.related);

	const remove = async () => {
		try {
			await onDelete();
			onBack?.();
		} catch (err) {
			setError(err.message || "Failed to delete");
		}
	};

	// Size the body frame to its content (and keep it fitted as images load)
	// so the reader scrolls as one page instead of a fixed-height box.
	const frameObserver = useRef(null);
	useEffect(() => () => frameObserver.current?.disconnect(), []);
	const fitFrame = useCallback((e) => {
		const frame = e.currentTarget;
		const body = frame.contentDocument?.body;
		frameObserver.current?.disconnect();
		if (!body) return;
		const fit = () => {
			frame.style.height = `${Math.max(120, body.scrollHeight)}px`;
		};
		fit();
		frameObserver.current = new ResizeObserver(fit);
		frameObserver.current.observe(body);
	}, []);

	if (loading) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-ink-muted">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-hair-strong border-t-indigo-500" />
				<span className="text-sm">Loading…</span>
			</div>
		);
	}

	if (error && !msg) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8">
				<div className="rounded-lg border border-danger/20 bg-danger/10 p-4 text-sm text-danger">
					{error}
				</div>
				<button
					type="button"
					onClick={onBack}
					className="flex items-center gap-2 text-sm text-ink-muted hover:text-ink-2"
				>
					<ArrowLeft className="h-4 w-4" /> Back
				</button>
			</div>
		);
	}

	if (!msg) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-ink-muted">
				<MailIcon className="h-10 w-10" />
				<p>No message</p>
				<button
					type="button"
					onClick={onBack}
					className="flex items-center gap-2 text-sm text-ink-muted hover:text-ink-2"
				>
					<ArrowLeft className="h-4 w-4" /> Back
				</button>
			</div>
		);
	}

	return (
		<div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden">
			{/* Toolbar */}
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-hair pl-14 pr-4 md:pl-4">
				<button
					type="button"
					onClick={onBack}
					className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					<ArrowLeft className="h-4 w-4" /> Back
				</button>
				<div className="flex-1" />
				{[
					["reply", Reply, "Reply", "r"],
					["replyAll", ReplyAll, "Reply all", "a"],
					["forward", Forward, "Forward", "f"],
				].map(([mode, Icon, label, key]) => (
					<button
						key={mode}
						type="button"
						onClick={() => onCompose?.(mode, msg)}
						title={`${label} (${key})`}
						className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition hover:bg-hover hover:text-ink-2"
					>
						<Icon className="h-4 w-4" />
						<span className="hidden lg:inline">{label}</span>
					</button>
				))}
				<button
					type="button"
					onClick={remove}
					title="Delete (#)"
					className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition hover:bg-danger/10 hover:text-danger"
				>
					<Trash2 className="h-4 w-4" /> Delete
				</button>
			</div>

			{/* Headers */}
			<div className="border-b border-hair px-6 py-5">
				<h1 className="text-xl font-semibold text-ink">
					{msg.subject || "(no subject)"}
				</h1>
				<div className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
					<div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/20 text-sm font-medium text-accent">
						{(msg.fromName || msg.from || "?").charAt(0).toUpperCase()}
					</div>
					<div>
						<div className="font-medium text-ink-2">
							{msg.fromName || msg.from}
						</div>
						<div className="text-xs text-ink-muted">
							{msg.from}
							{msg.to ? `  →  ${msg.to}` : ""}
						</div>
					</div>
					<div className="flex-1" />
					<div className="flex items-center gap-2">
						{files.length > 0 && (
							<span className="flex items-center gap-1 text-xs text-ink-muted">
								<Paperclip className="h-3.5 w-3.5" />
								{files.length}
							</span>
						)}
						<button
							type="button"
							onClick={() => setShowDetails((v) => !v)}
							className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted transition hover:bg-hover hover:text-ink-2"
						>
							{showDetails ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
							Details
						</button>
						<div className="text-right">
							<div className="text-xs text-ink-muted">
								{msg.date ? formatDate(msg.date) : ""}
							</div>
							<div className="text-[10px] text-ink-faint">
								{msg.date ? new Date(msg.date).toLocaleString() : ""}
							</div>
						</div>
					</div>
				</div>

				{/* Toggleable full detail panel */}
				{showDetails && (
					<div className="mt-4 space-y-1.5 rounded-lg border border-hair bg-panel/40 p-4 text-sm">
						<DetailRow label="From" value={msg.from || "—"} />
						<DetailRow label="Reply-to" value={msg.replyTo || "—"} />
						<DetailRow label="To" value={msg.to || "—"} />
						<DetailRow
							label="Date"
							value={msg.date ? new Date(msg.date).toLocaleString() : "—"}
						/>
						<DetailRow label="Subject" value={msg.subject || "(no subject)"} />
					</div>
				)}

				{/* Attachment cards — download on click */}
				{files.length > 0 && (
					<div className="mt-4 space-y-2">
						{files.map((a) => (
							<a
								key={a.index}
								href={attachmentUrl(msg.folder || thisFolder, msg.uid, a.index)}
								download={a.filename}
								title={`Download ${a.filename}`}
								className="flex w-full items-center gap-3 rounded-lg border border-hair bg-panel/40 p-3 text-left transition hover:border-indigo-700 hover:bg-panel"
							>
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
									<Download className="h-4 w-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium text-ink-2">
										{a.filename}
									</div>
									<div className="truncate text-xs text-ink-muted">
										{a.contentType}
										{a.size ? ` · ${formatBytes(a.size)}` : ""}
									</div>
								</div>
								<FileWarning className="h-4 w-4 shrink-0 text-ink-faint" />
							</a>
						))}
					</div>
				)}
			</div>

			{/* Body — rendered inside a sandboxed iframe so the email's own CSS
			    cannot bleed out into the app's styling. */}
			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				{showRemoteButton && (
					<div className="mb-3 flex justify-end">
						<button
							type="button"
							onClick={() => setShowRemote(true)}
							title="Load images sent from external servers"
							className="flex items-center gap-1.5 rounded-lg border border-hair bg-panel px-3 py-1.5 text-xs text-ink-2 transition hover:bg-hover"
						>
							<ImageIcon className="h-3.5 w-3.5 text-ink-muted" />
							Load remote images
						</button>
					</div>
				)}
				{msg.html ? (
					<iframe
						title="email-body"
						sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
						srcDoc={emailDoc(msg.html, showRemote)}
						onLoad={fitFrame}
						className="mail-body-frame block w-full rounded-lg border border-hair bg-white"
						style={{ height: 120 }}
					/>
				) : msg.text ? (
					looksLikeMarkdown(msg.text) ? (
						<div
							className="mail-markdown prose prose-invert max-w-none text-sm leading-relaxed text-ink-2"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: later
							dangerouslySetInnerHTML={{
								// Incoming mail is untrusted — sanitize the rendered
								// markdown so embedded HTML/script can not run.
								__html: DOMPurify.sanitize(marked.parse(msg.text)),
							}}
						/>
					) : (
						<pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-2">
							{msg.text}
						</pre>
					)
				) : (
					<div className="text-sm text-ink-muted">(no body)</div>
				)}
			</div>
		</div>
	);
}
