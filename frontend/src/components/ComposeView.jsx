import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../context/auth.jsx";
import { apiCall } from "../utils/apiCall.js";
import { closingSave, trackClosingSave } from "../utils/closingSaves.js";
import { parseAddress, rememberContacts, splitRecipients, suggestContacts } from "../utils/contacts.js";
import { addSignature, markdownSafeSignature, signatureBlock } from "../utils/signature.js";
import { ArrowLeft, Send, Paperclip, X, FileText, Trash2, Undo2 } from "lucide-react";

const EMPTY_FORM = { to: "", cc: "", bcc: "", subject: "", text: "", markdown: false };
// Bump when the backend's attachment index numbering changes, so saved forward
// references from older drafts are dropped instead of picking the wrong file.
// 3: nameless inline text/plain and text/html parts are no longer counted.
const ATTACHMENT_INDEX_VERSION = 3;
// Send waits this long so it can be undone. Closing the tab meanwhile sends
// nothing; the message stays as the local draft.
export const UNDO_SEND_MS = 5000;
// Undo sits where Send was; ignore clicks this soon after Send so the second
// click of a double-click doesn't cancel the send.
const UNDO_GUARD_MS = 400;

// One auto-saved draft per mailbox, kept in localStorage. Uploaded files are
// not saved (they can blow the storage quota); forwarded ones are just
// references, so they are.
function loadDraft(key) {
	try {
		const draft = JSON.parse(localStorage.getItem(key)) || null;
		if (draft && draft.attachmentIndexVersion !== ATTACHMENT_INDEX_VERSION && draft.attachments?.some((a) => a.forward)) {
			return { ...draft, attachments: draft.attachments.filter((a) => !a.forward), outdatedAttachments: true };
		}
		return draft;
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

// A body that is only the auto-inserted signature doesn't count as content.
function hasContent(draft) {
	const { form } = draft;
	if (["to", "cc", "bcc", "subject"].some((k) => form[k]?.trim())) return true;
	const text = form.text?.trim();
	return !!text && text !== signatureBlock(draft.signature).trim();
}

function persistDraft(key, draft) {
	if (!hasContent(draft)) {
		clearDraft(key);
		return false;
	}
	try { localStorage.setItem(key, JSON.stringify(draft)); return true; }
	catch { return false; }
}

// Server drafts (IMAP Drafts folder) are the durable, cross-device copy; the
// local draft above stays the instant one. While editing, the server copy is
// refreshed at most every DRAFT_SAVE_MS, and only while uploads are small:
// re-sending big base64 attachments on a timer is wasteful, so those are
// saved on close only.
export const DRAFT_SAVE_MS = 30000;
const AUTO_SAVE_LIMIT = 2 * 1024 * 1024;
// What a save makes the server store again: uploads (base64) plus the
// attachments it copies over from the current copy (`uid`).
const autoSaveSize = (attachments, uid) =>
	attachments.reduce((n, a) => n + (a.forward ? (uid && a.forward.uid === uid ? a.size || 0 : 0) : a.content?.length || 0), 0);
// Attachments in total (uploads and forwarded refs alike). Saved uploads
// become forwarded refs, which the server caps at 25 MiB; keep a margin.
export const ATTACHMENT_BUDGET = 24 * 1024 * 1024;
const totalSize = (attachments) => attachments.reduce((n, a) => n + (a.size || 0), 0);

// The body of both /mail/send and /mail/drafts, so a draft keeps what a send would.
function messageBody(form, meta, attachments, signature) {
	const forwarded = attachments.filter((a) => a.forward);
	return {
		...form,
		text: form.markdown ? markdownSafeSignature(form.text, signature) : form.text,
		...meta,
		attachments: attachments.filter((a) => !a.forward).map(({ size, ...a }) => a),
		forwardAttachments: forwarded.length
			? {
					folder: forwarded[0].forward.folder,
					uid: forwarded[0].forward.uid,
					indexes: forwarded.map((a) => a.forward.index),
				}
			: undefined,
	};
}

const discardServerDraft = (uid) => apiCall.post("/mail/drafts/discard", { uid }).catch(() => {});

// Updates the local draft after a server save (UID, moved attachment refs),
// but only if it is still this composer's (another composer may have replaced it).
function patchLocalDraft(key, session, patch) {
	try {
		const draft = JSON.parse(localStorage.getItem(key));
		if (draft?.session !== session) return;
		localStorage.setItem(key, JSON.stringify({ ...draft, ...patch }));
	} catch {
		// storage unavailable; the UID lives on in memory only
	}
}

// Asked before leaving only when uploads may really be lost: the last server
// save failed, or no further save is possible (see the no-UID rule).
export const UPLOADS_AT_RISK_PROMPT = "Uploaded files could not be saved to Drafts and may be lost. Leave anyway?";

const SERVER_STATUS = {
	saving: "Saving draft…",
	saved: "Draft saved to Drafts",
	local: "Draft saved on this device only",
};

const readBase64 = (file) =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

const draftKeyFor = (user) => `ezmail_draft:${user?.mailbox || ""}`;

// `initial` (from utils/reply.js) prefills a reply/forward; without it a saved
// draft is restored, once a close-time save of it has settled (its UID and
// attachment refs change on save).
export default function ComposeView(props) {
	const { user } = useAuth();
	const draftKey = draftKeyFor(user);
	const [waiting, setWaiting] = useState(() => !props.initial && !!closingSave(draftKey));
	useEffect(() => {
		if (!waiting) return;
		const settled = closingSave(draftKey);
		if (!settled) {
			setWaiting(false);
			return;
		}
		let live = true;
		settled.then(() => { if (live) setWaiting(false); });
		return () => { live = false; };
	}, [waiting, draftKey]);
	if (waiting) return <p role="status" className="flex h-full items-center justify-center text-sm text-ink-muted">Saving your previous draft…</p>;
	return <Composer {...props} />;
}

function Composer({ onBack, initial, onSent, onBusyChange, onUploadsChange, onDraftsChange, onDraftSaveFailed }) {
	const { user } = useAuth();
	const draftKey = draftKeyFor(user);
	const [start] = useState(() => {
		if (initial) return initial;
		const draft = loadDraft(draftKey);
		return draft ? { ...draft, restored: true } : {};
	});
	const [form, setForm] = useState({ ...EMPTY_FORM, ...start.form });
	const [meta] = useState(start.meta || {}); // inReplyTo / references
	const [attachments, setAttachments] = useState(start.attachments || []); // {filename, contentType, content(base64)}
	// Server draft state. `uid` is the copy in Drafts that the next save
	// replaces (restored from the local draft, or the draft being resumed);
	// `saved` is the content last stored there (by reference); `pending` is a
	// save waiting for the one in flight; `done` is set after Send or Discard.
	const srv = useRef(null);
	if (!srv.current) {
		srv.current = { uid: start.draftUid ?? null, saved: start.fromServer ? { form, attachments } : null, pending: null, flight: null, noUid: false, noUidCloseUsed: false, closed: false, done: false };
	}
	const [session] = useState(() => Math.random().toString(36).slice(2));
	const [serverStatus, setServerStatus] = useState(""); // "" | "saving" | "saved" | "local"
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	const autoTimer = useRef(null);
	const draftsChangeRef = useRef(onDraftsChange);
	draftsChangeRef.current = onDraftsChange;
	const saveFailedRef = useRef(onDraftSaveFailed);
	saveFailedRef.current = onDraftSaveFailed;
	const [closing, setClosing] = useState(false); // Back is waiting for a save
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(start.outdatedAttachments ? "Forwarded attachments from this older draft were removed. Add them again before sending." : "");
	const [sent, setSent] = useState(false);
	const uploadsAtRisk = !sent && attachments.some((a) => !a.forward) &&
		(serverStatus === "local" || (srv.current.noUid && srv.current.noUidCloseUsed));
	useEffect(() => { onUploadsChange?.(uploadsAtRisk); }, [uploadsAtRisk, onUploadsChange]);
	const [sentWarning, setSentWarning] = useState("");
	const [draftSaved, setDraftSaved] = useState(false);
	useEffect(() => {
		if (!busy && (sent || !attachments.some((a) => !a.forward))) return;
		const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [busy, attachments, sent]);
	const fileRef = useRef(null);
	const discardRef = useRef(false);
	const draftRef = useRef(null);
	// Signature text in this body ("" = none); restored drafts already have theirs.
	// A resumed server draft gets "": its signature is ordinary (user) text, so
	// a markdown send never escapes it a second time.
	const signatureRef = useRef(start.signature || "");
	draftRef.current = { title: start.title, attachmentIndexVersion: ATTACHMENT_INDEX_VERSION, signature: signatureRef.current || undefined, form, meta, attachments: attachments.filter((a) => a.forward), draftUid: srv.current.uid ?? undefined, session };
	const latest = useRef(null);
	latest.current = { form, meta, attachments };
	const formRef = useRef(form);
	formRef.current = form;
	const [countdown, setCountdown] = useState(0); // seconds left before sending; 0 = not counting
	const sendTimer = useRef(null);
	const tickTimer = useRef(null);
	const undoRef = useRef(null);
	const sendRef = useRef(null);
	const sendLatest = useRef(null); // the timer must send what's on screen now
	const stopCountdown = () => {
		clearTimeout(sendTimer.current);
		clearInterval(tickTimer.current);
		sendTimer.current = tickTimer.current = null;
	};
	// Closing/unmounting during the countdown cancels the send (the draft is kept).
	useEffect(() => () => {
		clearTimeout(sendTimer.current);
		clearInterval(tickTimer.current);
	}, []);
	const counting = countdown > 0;
	// The parent blocks navigation while we're sending or counting down (Undo
	// is the way out), and must never be left blocked by an unmounted composer.
	useEffect(() => { onBusyChange?.(busy || counting); }, [busy, counting, onBusyChange]);
	const sendingRef = useRef(false);
	sendingRef.current = busy || counting;
	const busyChangeRef = useRef(onBusyChange);
	busyChangeRef.current = onBusyChange;
	useEffect(() => () => busyChangeRef.current?.(false), []);
	const [reading, setReading] = useState(0); // attachment files still being read
	const undoArmedAt = useRef(0); // Undo ignores clicks before this time
	useEffect(() => { if (counting) undoRef.current?.focus(); }, [counting]);

	// Add the profile signature to new messages, replies and forwards, but not
	// to a restored draft (it already has one) and not once the user has typed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per composer
	useEffect(() => {
		if (start.restored || start.signature !== undefined) return;
		let live = true;
		const untouched = start.form?.text || "";
		apiCall.get("/profile").then((res) => {
			const signature = res.data?.signature || "";
			if (!live || !signatureBlock(signature) || formRef.current.text !== untouched) return;
			signatureRef.current = signature;
			setForm((f) => (f.text === untouched ? { ...f, text: addSignature(f.text, signature) } : f));
		}).catch(() => {}); // no signature if the profile can't load
		return () => { live = false; };
	}, []);
	// Serialised server saves: one POST /mail/drafts at a time; a save due
	// meanwhile runs once afterwards with the content current at that point.
	// Requests are never aborted, so a close-time save outlives the composer.
	// Returns why nothing was sent ("skip" / "unchanged"), or `s.flight`: the
	// running save, which never rejects and resolves to "ok" / "fail" / "done".
	const pumpSave = () => {
		const s = srv.current;
		if (s.flight || !s.pending) return null;
		const reason = s.pending;
		s.pending = null;
		const { form: f, meta: m, attachments: atts } = latest.current;
		if (s.done || !hasContent(draftRef.current)) return "skip";
		if (s.saved?.form === f && s.saved?.attachments === atts) return "unchanged";
		if (reason === "auto" && (s.noUid || sendingRef.current || autoSaveSize(atts, s.uid) >= AUTO_SAVE_LIMIT)) return "skip";
		if (s.noUid) {
			if (s.noUidCloseUsed) return "skip";
			s.noUidCloseUsed = true;
		}
		if (mounted.current) setServerStatus("saving");
		s.flight = apiCall
			.post("/mail/drafts", { ...messageBody(f, m, atts, signatureRef.current), replaces: s.uid ?? undefined })
			.then((res) => {
				const uid = res.data?.uid;
				if (s.done) {
					// Sent or discarded while this save was out: don't resurrect it.
					if (uid) discardServerDraft(uid).then(() => draftsChangeRef.current?.());
					return "done";
				}
				if (uid) {
					// Every attachment just sent now lives in the new copy, which
					// the server composed as uploads first, then forwarded ones in
					// `indexes` order; the old copy is gone. Point the refs at the
					// new copy, and the uploads too (no re-upload on the next save)
					// unless that would take the refs over the server's forwarding
					// limit: then they stay uploads, which it doesn't count.
					const folder = res.data.folder;
					const order = [...atts.filter((a) => !a.forward), ...atts.filter((a) => a.forward)];
					const fits = totalSize(atts) <= ATTACHMENT_BUDGET;
					const moved = new Map(
						order
							.map((a, index) => [a, { filename: a.filename, contentType: a.contentType, size: a.size, forward: { folder, uid, index } }])
							.filter(([a]) => fits || a.forward),
					);
					const remap = (list) => list.map((a) => moved.get(a) || a);
					const remapped = remap(atts);
					const cur = latest.current.attachments;
					const next = cur === atts ? remapped : remap(cur);
					latest.current = { ...latest.current, attachments: next }; // a queued save must see it now
					if (mounted.current) setAttachments((c) => (c === cur ? next : remap(c)));
					s.saved = { form: f, attachments: remapped };
					s.uid = uid;
					patchLocalDraft(draftKey, session, { draftUid: uid, attachments: next.filter((a) => a.forward), attachmentIndexVersion: ATTACHMENT_INDEX_VERSION });
				} else {
					// No UID (server can't report it): later saves couldn't replace
					// this copy and would pile up duplicates, so stop periodic saves
					// and allow at most one more save, on close. The old copy is
					// kept when our attachment refs point at it, so they stay valid.
					s.saved = { form: f, attachments: atts };
					s.noUid = true;
					if (res.data?.replaced) s.uid = null;
					patchLocalDraft(draftKey, session, { draftUid: s.uid ?? undefined });
				}
				if (mounted.current) setServerStatus("saved");
				draftsChangeRef.current?.();
				return "ok";
			}, () => {
				if (mounted.current && !s.done) setServerStatus("local");
				// Closed already, with no retry queued: only the parent can say so.
				else if (!s.done && !s.pending) saveFailedRef.current?.({ hadUploads: atts.some((a) => !a.forward) });
				return "fail";
			})
			.finally(() => {
				s.flight = null;
				pumpSave();
			});
		return s.flight;
	};
	// Saves now (after any save already out) and resolves to the outcome.
	const flushSave = async () => {
		const s = srv.current;
		while (s.flight) await s.flight;
		s.pending = "close";
		return (await pumpSave()) || "skip";
	};
	const requestSave = (reason) => {
		const s = srv.current;
		if (reason === "close") {
			if (s.closed) return;
			s.closed = true;
		}
		if (s.pending !== "close") s.pending = reason;
		pumpSave();
	};
	const requestSaveRef = useRef(requestSave);
	requestSaveRef.current = requestSave;
	const stopServerSaves = () => {
		const s = srv.current;
		s.done = true;
		s.pending = null;
		clearTimeout(autoTimer.current);
		autoTimer.current = null;
		return s.uid;
	};

	// The close-time save waits a microtask: StrictMode's dev-only
	// unmount/remount cycle remounts synchronously and so cancels it.
	useEffect(() => () => {
		clearTimeout(autoTimer.current);
		autoTimer.current = null; // a remount schedules it again
		if (discardRef.current) return;
		persistDraft(draftKey, draftRef.current);
		// A composer opened meanwhile waits until every save of ours settled.
		const s = srv.current;
		const track = () => s.flight && trackClosingSave(draftKey, (async () => {
			while (s.flight) await s.flight;
		})());
		track(); // e.g. the save Back just started
		queueMicrotask(() => {
			if (mounted.current) return;
			requestSaveRef.current("close");
			track();
		});
	}, [draftKey]);

	// Periodic server save: the first change after a save starts the timer;
	// later changes don't push it back. Never during the countdown or a send.
	useEffect(() => {
		const s = srv.current;
		if (sent || counting || busy || autoTimer.current || s.noUid || s.done) return;
		if (s.saved?.form === form && s.saved?.attachments === attachments) return;
		autoTimer.current = setTimeout(() => {
			autoTimer.current = null;
			requestSaveRef.current("auto");
		}, DRAFT_SAVE_MS);
	}, [form, attachments, counting, busy, sent]);

	// Debounced auto-save while typing.
	useEffect(() => {
		if (sent) return;
		setDraftSaved(false);
		const s = srv.current;
		// Moving attachment refs after a save is not an edit.
		if (s.saved?.form !== form || s.saved?.attachments !== attachments) setServerStatus((st) => (st === "saved" ? "" : st));
		if (!hasContent(draftRef.current)) { clearDraft(draftKey); return; }
		const id = setTimeout(() => setDraftSaved(persistDraft(draftKey, draftRef.current)), 800);
		return () => clearTimeout(id);
	}, [form, attachments, draftKey, sent]);

	const leave = () => {
		srv.current.closed = true; // no second close-time save
		onBack?.();
	};
	const saveBeforeBack = async () => {
		if (sent) return onBack?.();
		// A second Back while waiting: the user may always leave.
		if (closing) return window.confirm(UPLOADS_AT_RISK_PROMPT) && leave();
		if (counting) undo(); // leaving cancels a pending send; the draft stays
		persistDraft(draftKey, draftRef.current);
		if (!latest.current.attachments.some((a) => !a.forward)) {
			requestSave("close");
			return onBack?.();
		}
		// Uploaded bytes exist only in memory: store them before closing. The
		// parent isn't held busy meanwhile; it can still navigate away.
		setClosing(true);
		const outcome = await flushSave();
		if (!mounted.current || srv.current.closed) return;
		setClosing(false);
		if (outcome === "ok" || outcome === "unchanged" || window.confirm(UPLOADS_AT_RISK_PROMPT)) leave();
	};

	const discard = () => {
		// A copy in Drafts may predate this composer (e.g. written elsewhere).
		if (srv.current.uid && !window.confirm("Delete this draft from Drafts?")) return;
		discardRef.current = true;
		const uid = stopServerSaves();
		if (uid) discardServerDraft(uid).then(() => draftsChangeRef.current?.());
		clearDraft(draftKey);
		onBack?.();
	};

	const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
	const suggest = (prefix) => suggestContacts(user?.mailbox, prefix);

	const onFiles = async (e) => {
		const files = Array.from(e.target.files || []);
		const existingBytes = attachments.filter((a) => !a.forward).reduce((n, a) => n + (a.size || 0), 0);
		const addedBytes = files.reduce((n, file) => n + file.size, 0);
		if (existingBytes + addedBytes > 22 * 1024 * 1024) {
			setError("Uploads exceed 22 MiB. The server limits the encoded request to 32 MiB.");
			e.target.value = "";
			return;
		}
		if (totalSize(attachments) + addedBytes > ATTACHMENT_BUDGET) {
			setError("Attachments would exceed 24 MiB in total, the most a saved draft can carry.");
			e.target.value = "";
			return;
		}
		setReading((n) => n + 1);
		try {
		const added = await Promise.all(
			files.map(async (file) => ({
				filename: file.name,
				size: file.size,
				contentType: file.type || "application/octet-stream",
				content: await readBase64(file),
			})),
		);
		setAttachments((prev) => [...prev, ...added]);
		} catch (err) { setError(err.message || "Could not read attachment"); }
		finally { setReading((n) => n - 1); }
		e.target.value = ""; // allow re-selecting the same file
	};

	const removeAttachment = (i) =>
		setAttachments((prev) => prev.filter((_, idx) => idx !== i));

	// Send (button or Ctrl+Enter) starts the undo countdown; the request goes
	// out when it ends.
	const submit = (e) => {
		e.preventDefault();
		if (busy || countdown) return;
		if (reading) {
			setError("Attachments are still loading. Try again in a moment.");
			return;
		}
		if (!form.to.trim()) {
			setError("Add at least one recipient.");
			return;
		}
		setError("");
		// No server save during the countdown or the send.
		clearTimeout(autoTimer.current);
		autoTimer.current = null;
		if (srv.current.pending === "auto") srv.current.pending = null;
		// The draft is on disk before the countdown, so closing the tab keeps it.
		persistDraft(draftKey, draftRef.current);
		setCountdown(Math.ceil(UNDO_SEND_MS / 1000));
		undoArmedAt.current = Date.now() + UNDO_GUARD_MS;
		tickTimer.current = setInterval(() => setCountdown((n) => Math.max(1, n - 1)), 1000);
		sendTimer.current = setTimeout(() => {
			stopCountdown();
			setCountdown(0);
			sendLatest.current();
		}, UNDO_SEND_MS);
	};

	const undo = () => {
		stopCountdown();
		setCountdown(0);
		setTimeout(() => sendRef.current?.focus());
	};

	const send = async () => {
		setBusy(true);
		try {
			// A save still out may be replacing the copy our refs point at; send
			// what it leaves (refs moved to the new copy).
			while (srv.current.flight) await srv.current.flight;
			const { form: f, meta: m, attachments: atts } = latest.current;
			const result = await apiCall.post("/mail/send", messageBody(f, m, atts, signatureRef.current));
			if (result.data?.savedToSent === false && !result.data?.sentSavingDisabled) setSentWarning("The message was sent, but could not be saved to Sent.");
			discardRef.current = true;
			// A late save response is discarded on arrival (see pumpSave).
			const draftUid = stopServerSaves();
			clearDraft(draftKey);
			rememberContacts(user?.mailbox, [f.to, f.cc, f.bcc]);
			setSent(true);
			// The parent refreshes once the server draft is gone.
			if (draftUid) discardServerDraft(draftUid).then(() => onSent?.());
			else onSent?.();
		} catch (err) {
			setError(err.message || "Failed to send");
		} finally {
			setBusy(false);
		}
	};

	sendLatest.current = send;

	if (sent) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-ink-muted">
				<p className="text-ink-2">Message sent ✅</p>
				{sentWarning && <p role="alert">{sentWarning}</p>}
				<button
					type="button"
					onClick={saveBeforeBack}
					disabled={busy}
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
					type="button"
					onClick={saveBeforeBack}
					disabled={busy}
					className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					<ArrowLeft className="h-4 w-4" />
					Back
				</button>
				<h2 className="ml-2 text-lg font-semibold">
					{start.title || "New message"}
				</h2>
				<div className="flex-1" />
				<span aria-live="polite" className="text-xs text-ink-faint">
					{SERVER_STATUS[serverStatus] || (draftSaved ? "Draft saved" : "")}
				</span>
				<button
					type="button"
					onClick={discard}
					disabled={busy || counting}
					title="Discard draft"
					className="rounded-lg p-2 text-ink-muted transition hover:bg-danger/10 hover:text-danger"
				>
					<Trash2 className="h-4 w-4" />
				</button>
				{counting ? (
					<>
						<span className="text-sm text-ink-2" aria-hidden="true">Sending in {countdown}…</span>
						<button
							ref={undoRef}
							type="button"
							onClick={() => { if (Date.now() >= undoArmedAt.current) undo(); }}
							className="flex items-center gap-2 rounded-lg border border-accent px-4 py-2 text-sm font-medium text-accent transition hover:bg-hover"
						>
							<Undo2 className="h-4 w-4" />
							Undo
						</button>
					</>
				) : (
					<button
						ref={sendRef}
						type="button"
						onClick={submit}
						disabled={busy}
						className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
					>
						<Send className="h-4 w-4" />
						{busy ? "Sending…" : "Send"}
					</button>
				)}
			</div>
			<p role="status" className="sr-only">
				{counting ? `Sending in ${Math.ceil(UNDO_SEND_MS / 1000)} seconds. Press Undo to cancel.` : ""}
			</p>

			{error && (
				<div className="m-4 rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
					{error}
				</div>
			)}
				<p className="px-4 py-1 text-xs text-ink-muted">One draft is saved locally per mailbox. Forwarded attachments are limited to 25 MiB total.</p>

			{/* Ctrl/⌘+Enter sends */}
			<form
				onSubmit={submit}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit(e);
				}}
				className="flex flex-1 flex-col"
			>
				<fieldset disabled={busy || counting} className="contents">
				<div className="space-y-0">
					<Field
						label="To"
						value={form.to}
						onChange={set("to")}
						suggest={suggest}
						disabled={busy || counting}
						placeholder="recipient@example.com"
						type="email"
						multiple
						required
					/>
					<Field
						label="Cc"
						value={form.cc}
						onChange={set("cc")}
						suggest={suggest}
						disabled={busy || counting}
						placeholder="cc@example.com"
						type="email"
						multiple
					/>
					<Field
						label="Bcc"
						value={form.bcc}
						onChange={set("bcc")}
						suggest={suggest}
						disabled={busy || counting}
						placeholder="hidden recipients"
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
							{attachments.some((a) => !a.forward) && <span className="w-full text-xs text-ink-muted">Uploaded files are saved with the draft to Drafts, not on this device.</span>}
							{attachments.map((a, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: stateless chips; filenames can repeat
									key={`${a.filename}-${i}`}
									className="flex items-center gap-1.5 rounded-md border border-hair-strong bg-panel px-2 py-1 text-xs text-ink-2"
								>
									<FileText className="h-3.5 w-3.5 text-accent" />
										<span className="max-w-[180px] truncate">{a.filename}</span>
										{typeof a.size === "number" && <span>({(a.size / 1024 / 1024).toFixed(2)} MiB)</span>}
									<button
										type="button"
										onClick={() => removeAttachment(i)}
											aria-label={`Remove ${a.filename}`}
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
				</fieldset>
			</form>
		</div>
	);
}

// A recipient field; with `suggest` it offers address-book matches for the
// address being typed after the last comma/semicolon (an ARIA combobox).
function Field({ label, value, onChange, placeholder, type, required, multiple, suggest, disabled }) {
	const id = useId();
	const listId = `${id}-list`;
	const [items, setItems] = useState([]);
	const [active, setActive] = useState(-1);
	const open = items.length > 0;
	const close = () => { setItems([]); setActive(-1); };
	// A disabled input never blurs, so its list would stay open.
	// biome-ignore lint/correctness/useExhaustiveDependencies: close only resets state
	useEffect(() => { if (disabled) close(); }, [disabled]);
	const lookup = (v) => {
		const parts = splitRecipients(v);
		const token = parts.at(-1).trim().toLowerCase();
		const used = new Set(parts.slice(0, -1).map((p) => parseAddress(p)?.address.toLowerCase()).filter(Boolean));
		setItems(token ? suggest(token).filter((c) => !used.has(c.address.toLowerCase()) && c.address.toLowerCase() !== token) : []);
		setActive(-1);
	};
	// Replaces only the token being typed; earlier recipients stay as they are.
	const accept = (c) => {
		const cut = Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) + 1;
		const head = value.slice(0, cut);
		onChange({ target: { value: head ? `${head} ${c.address}` : c.address } });
		close();
	};
	const onKeyDown = (e) => {
		if (!suggest || e.ctrlKey || e.metaKey || e.altKey) return;
		if (!open) {
			if (e.key === "ArrowDown") lookup(value);
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setActive((a) => (a < 0 && step < 0 ? items.length - 1 : (a + step + items.length) % items.length));
		} else if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && active >= 0) {
			e.preventDefault();
			accept(items[active]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};
	return (
		<div className="relative flex items-center gap-3 border-b border-hair px-4 py-2">
			<label
				htmlFor={id}
				className="w-16 shrink-0 text-sm font-medium text-ink-muted"
			>
				{label}
			</label>
			<input
				id={id}
				type={type || "text"}
				value={value}
				onChange={(e) => {
					onChange(e);
					if (suggest) lookup(e.target.value);
				}}
				onKeyDown={onKeyDown}
				onBlur={suggest ? close : undefined}
				placeholder={placeholder}
				required={required}
				multiple={multiple}
				{...(suggest && {
					role: "combobox",
					autoComplete: "off",
					"aria-autocomplete": "list",
					"aria-expanded": open,
					"aria-controls": open ? listId : undefined,
					"aria-activedescendant": active >= 0 ? `${listId}-${active}` : undefined,
				})}
				className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
			/>
			{open && (
				<div
					id={listId}
					role="listbox"
					aria-label={`${label} suggestions`}
					className="absolute left-20 right-4 top-full z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-hair-strong bg-panel py-1 shadow-lg"
				>
					{items.map((c, i) => (
						// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled on the combobox input
						<div
							key={c.address}
							id={`${listId}-${i}`}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => accept(c)}
							className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? "bg-hover text-ink" : "text-ink-2"}`}
						>
							{c.name ? <>{c.name} <span className="text-ink-muted">&lt;{c.address}&gt;</span></> : c.address}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
