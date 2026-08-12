import { useState, useRef } from "react";
import { apiCall } from "../utils/apiCall.js";
import { ArrowLeft, Send, Paperclip, X, FileText } from "lucide-react";

export default function ComposeView({ onBack }) {
	const [form, setForm] = useState({
		to: "",
		cc: "",
		subject: "",
		text: "",
		markdown: false,
	});
	const [attachments, setAttachments] = useState([]); // {filename, contentType, content(base64)}
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const fileRef = useRef(null);

	const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

	const onFiles = async (e) => {
		const files = Array.from(e.target.files || []);
		const added = [];
		for (const file of files) {
			const buf = await file.arrayBuffer();
			const bytes = new Uint8Array(buf);
			let binary = "";
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
			added.push({
				filename: file.name,
				contentType: file.type || "application/octet-stream",
				content: btoa(binary),
			});
		}
		setAttachments((prev) => [...prev, ...added]);
		e.target.value = ""; // allow re-selecting the same file
	};

	const removeAttachment = (i) =>
		setAttachments((prev) => prev.filter((_, idx) => idx !== i));

	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await apiCall.post("/mail/send", { ...form, attachments });
			setSent(true);
		} catch (err) {
			setError(err.message || "Failed to send");
		} finally {
			setBusy(false);
		}
	};

	if (sent) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-zinc-500">
				<p className="text-zinc-200">Message sent ✅</p>
				<button
					onClick={onBack}
					className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
				>
					Back to inbox
				</button>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
				<button
					onClick={onBack}
					className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
				>
					<ArrowLeft className="h-4 w-4" />
					Back
				</button>
				<h2 className="ml-2 text-lg font-semibold">New message</h2>
				<div className="flex-1" />
				<button
					onClick={submit}
					disabled={busy}
					className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
				>
					<Send className="h-4 w-4" />
					{busy ? "Sending…" : "Send"}
				</button>
			</div>

			{error && (
				<div className="m-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-400">
					{error}
				</div>
			)}

			<form onSubmit={submit} className="flex flex-1 flex-col">
				<div className="space-y-0">
					<Field
						label="To"
						value={form.to}
						onChange={set("to")}
						placeholder="recipient@example.com"
						type="email"
						required
					/>
					<Field
						label="Cc"
						value={form.cc}
						onChange={set("cc")}
						placeholder="cc@example.com"
						type="email"
					/>
					<Field
						label="Subject"
						value={form.subject}
						onChange={set("subject")}
						placeholder="Subject"
					/>

					{/* Attachment chips */}
					{attachments.length > 0 && (
						<div className="flex flex-wrap gap-2 border-b border-zinc-800 px-4 py-2">
							{attachments.map((a, i) => (
								<span
									key={`${a.filename}-${i}`}
									className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
								>
									<FileText className="h-3.5 w-3.5 text-indigo-400" />
									<span className="max-w-[180px] truncate">{a.filename}</span>
									<button
										type="button"
										onClick={() => removeAttachment(i)}
										className="text-zinc-500 hover:text-red-400"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</span>
							))}
						</div>
					)}

					{/* Body toolbar: attach + markdown toggle */}
					<div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-1.5">
						<button
							type="button"
							onClick={() => fileRef.current?.click()}
							className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
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
						<label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200">
							<input
								type="checkbox"
								checked={form.markdown}
								onChange={(e) => setForm((f) => ({ ...f, markdown: e.target.checked }))}
								className="accent-indigo-500"
							/>
							Markdown
						</label>
					</div>
				</div>

				<textarea
					value={form.text}
					onChange={set("text")}
					className="flex-1 resize-none border-t border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
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

function Field({ label, value, onChange, placeholder, type, required }) {
	return (
		<div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
			<label className="w-16 shrink-0 text-sm font-medium text-zinc-500">
				{label}
			</label>
			<input
				type={type || "text"}
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				required={required}
				className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
			/>
		</div>
	);
}