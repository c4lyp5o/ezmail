import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/auth.jsx";
import { apiCall } from "../utils/apiCall.js";
import { ArrowLeft, Send, Paperclip, X, FileText, Trash2 } from "lucide-react";

const EMPTY_FORM = { to: "", cc: "", subject: "", text: "", markdown: false };

// One auto-saved draft per mailbox, kept in localStorage (attachments are not
// saved — they can blow the storage quota).
function loadDraft(key) {
	try {
		return JSON.parse(localStorage.getItem(key)) || null;
	} catch {
		return null;
	}
}

function clearDraft(key) {
	try {
		localStorage.removeItem(key);
	} catch {
		// storage unavailable; nothing to clear
	}
}

const readBase64 = (file) =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

// `initial` (from utils/reply.js) prefills a reply/forward; without it a saved
// draft is restored.
export default function ComposeView({ onBack, initial, onSent }) {
	const { user } = useAuth();
	const draftKey = `ezmail_draft:${user?.mailbox || ""}`;
	const [start] = useState(() => initial || loadDraft(draftKey) || {});
	const [form, setForm] = useState({ ...EMPTY_FORM, ...start.form });
	const [meta] = useState(start.meta || {}); // inReplyTo / references
	const [attachments, setAttachments] = useState(start.attachments || []); // {filename, contentType, content(base64)}
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const [draftSaved, setDraftSaved] = useState(false);
	const fileRef = useRef(null);

	// Debounced auto-save while typing.
	useEffect(() => {
		if (sent) return;
		setDraftSaved(false);
		const hasContent = ["to", "cc", "subject", "text"].some((k) =>
			form[k]?.trim(),
		);
		if (!hasContent) return;
		const id = setTimeout(() => {
			try {
				localStorage.setItem(
					draftKey,
					JSON.stringify({ title: start.title, form, meta }),
				);
				setDraftSaved(true);
			} catch {
				// storage full/unavailable; draft just isn't kept
			}
		}, 800);
		return () => clearTimeout(id);
	}, [form, meta, draftKey, sent, start.title]);

	const discard = () => {
		clearDraft(draftKey);
		onBack?.();
	};

	const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

	const onFiles = async (e) => {
		const files = Array.from(e.target.files || []);
		const added = await Promise.all(
			files.map(async (file) => ({
				filename: file.name,
				contentType: file.type || "application/octet-stream",
				content: await readBase64(file),
			})),
		);
		setAttachments((prev) => [...prev, ...added]);
		e.target.value = ""; // allow re-selecting the same file
	};

	const removeAttachment = (i) =>
		setAttachments((prev) => prev.filter((_, idx) => idx !== i));

	const submit = async (e) => {
		e.preventDefault();
		if (busy) return;
		if (!form.to.trim()) {
			setError("Add at least one recipient.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await apiCall.post("/mail/send", { ...form, ...meta, attachments });
			clearDraft(draftKey);
			setSent(true);
			onSent?.();
		} catch (err) {
			setError(err.message || "Failed to send");
		} finally {
			setBusy(false);
		}
	};

	if (sent) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-ink-muted">
				<p className="text-ink-2">Message sent ✅</p>
				<button
					onClick={onBack}
					className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent"
				>
					Back to inbox
				</button>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-2 border-b border-hair py-3 pl-14 pr-4 md:pl-4">
				<button
					onClick={onBack}
					className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					<ArrowLeft className="h-4 w-4" />
					Back
				</button>
				<h2 className="ml-2 text-lg font-semibold">
					{start.title || "New message"}
				</h2>
				<div className="flex-1" />
				{draftSaved && (
					<span className="text-xs text-ink-faint">Draft saved</span>
				)}
				<button
					type="button"
					onClick={discard}
					title="Discard draft"
					className="rounded-lg p-2 text-ink-muted transition hover:bg-danger/10 hover:text-danger"
				>
					<Trash2 className="h-4 w-4" />
				</button>
				<button
					onClick={submit}
					disabled={busy}
					className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
				>
					<Send className="h-4 w-4" />
					{busy ? "Sending…" : "Send"}
				</button>
			</div>

			{error && (
				<div className="m-4 rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
					{error}
				</div>
			)}

			{/* Ctrl/⌘+Enter sends */}
			<form
				onSubmit={submit}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit(e);
				}}
				className="flex flex-1 flex-col"
			>
				<div className="space-y-0">
					<Field
						label="To"
						value={form.to}
						onChange={set("to")}
						placeholder="recipient@example.com"
						type="email"
						multiple
						required
					/>
					<Field
						label="Cc"
						value={form.cc}
						onChange={set("cc")}
						placeholder="cc@example.com"
						type="email"
						multiple
					/>
					<Field
						label="Subject"
						value={form.subject}
						onChange={set("subject")}
						placeholder="Subject"
					/>

					{/* Attachment chips */}
					{attachments.length > 0 && (
						<div className="flex flex-wrap gap-2 border-b border-hair px-4 py-2">
							{attachments.map((a, i) => (
								<span
									key={`${a.filename}-${i}`}
									className="flex items-center gap-1.5 rounded-md border border-hair-strong bg-panel px-2 py-1 text-xs text-ink-2"
								>
									<FileText className="h-3.5 w-3.5 text-accent" />
									<span className="max-w-[180px] truncate">{a.filename}</span>
									<button
										type="button"
										onClick={() => removeAttachment(i)}
										className="text-ink-muted hover:text-danger"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</span>
							))}
						</div>
					)}

					{/* Body toolbar: attach + markdown toggle */}
					<div className="flex items-center gap-2 border-b border-hair px-4 py-1.5">
						<button
							type="button"
							onClick={() => fileRef.current?.click()}
							className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted transition hover:bg-hover hover:text-ink-2"
						>
							<Paperclip className="h-3.5 w-3.5" /> Attach
						</button>
						<input
							ref={fileRef}
							type="file"
							multiple
							onChange={onFiles}
							className="hidden"
						/>
						<label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-muted transition hover:bg-hover hover:text-ink-2">
							<input
								type="checkbox"
								checked={form.markdown}
								onChange={(e) => setForm((f) => ({ ...f, markdown: e.target.checked }))}
								className="accent-accent"
							/>
							Markdown
						</label>
					</div>
				</div>

				<textarea
					value={form.text}
					onChange={set("text")}
					className="flex-1 resize-none border-t border-hair bg-canvas p-4 text-sm text-ink outline-none placeholder:text-ink-faint"
					placeholder={
						form.markdown
							? "Write your message in **markdown**… (# heading, - list, *italic*…)"
							: "Write your message…"
					}
				/>
			</form>
		</div>
	);
}

function Field({ label, value, onChange, placeholder, type, required, multiple }) {
	return (
		<div className="flex items-center gap-3 border-b border-hair px-4 py-2">
			<label className="w-16 shrink-0 text-sm font-medium text-ink-muted">
				{label}
			</label>
			<input
				type={type || "text"}
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				required={required}
				multiple={multiple}
				className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
			/>
		</div>
	);
}