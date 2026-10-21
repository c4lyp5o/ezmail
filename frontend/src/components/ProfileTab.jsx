import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiCall } from "../utils/apiCall.js";

// Profile tab: the display name recipients see in the From header.
export default function ProfileTab({ mailbox }) {
	const [name, setName] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");

	useEffect(() => {
		apiCall
			.get("/profile")
			.then((res) => setName(res.data?.displayName || ""))
			.catch(() => {})
			.finally(() => setLoaded(true));
	}, []);

	const save = async (e) => {
		e.preventDefault();
		setBusy(true);
		setNotice("");
		try {
			const res = await apiCall.put("/profile", { displayName: name });
			setName(res.data?.displayName || "");
			setNotice("Saved");
		} catch (err) {
			setNotice(err.message || "Failed to save");
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={save} className="space-y-4">
			<div>
				<label
					htmlFor="profile-name"
					className="mb-1.5 block text-sm font-medium text-ink-2"
				>
					Display name
				</label>
				<input
					id="profile-name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					disabled={!loaded}
					maxLength={100}
					placeholder={mailbox}
					className="w-full rounded-lg border border-hair bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-accent"
				/>
				<p className="mt-1.5 text-xs text-ink-muted">
					Shown to recipients as “{name.trim() || mailbox}” &lt;{mailbox}&gt;.
				</p>
			</div>
			<div className="flex items-center gap-3">
				<button
					type="submit"
					disabled={busy || !loaded}
					className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
				>
					{busy && <Loader2 className="h-4 w-4 animate-spin" />}
					Save
				</button>
				{notice && <span className="text-sm text-ink-muted">{notice}</span>}
			</div>
		</form>
	);
}
