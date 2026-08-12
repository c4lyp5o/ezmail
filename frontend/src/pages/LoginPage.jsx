import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/auth.jsx";
import { Mail } from "lucide-react";

export default function LoginPage() {
	const { login } = useAuth();
	const navigate = useNavigate();
	const [mailbox, setMailbox] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await login(mailbox.trim(), password, rememberMe);
			navigate("/mail", { replace: true });
		} catch (err) {
			setError(err.message || "Login failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-3">
					<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-400">
						<Mail className="h-7 w-7" />
					</div>
					<h1 className="text-2xl font-semibold text-zinc-100">ezmail</h1>
					<p className="text-sm text-zinc-500">Sign in to your mailbox</p>
				</div>

				<form onSubmit={submit} className="space-y-4">
					<div>
						<label className="mb-1 block text-sm font-medium text-zinc-400">
							Email address
						</label>
						<input
							type="email"
							value={mailbox}
							onChange={(e) => setMailbox(e.target.value)}
							className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
							placeholder="you@example.com"
							autoFocus
							required
						/>
					</div>

					<div>
						<label className="mb-1 block text-sm font-medium text-zinc-400">
							Password
						</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
							placeholder="Enter your mail password"
							required
						/>
					</div>

					<label className="flex items-center gap-2 text-sm text-zinc-400">
						<input
							type="checkbox"
							checked={rememberMe}
							onChange={(e) => setRememberMe(e.target.checked)}
							className="h-4 w-4 rounded border-zinc-800 bg-zinc-900"
						/>
						Remember me
					</label>

					{error && (
						<div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
							{error}
						</div>
					)}

					<button
						type="submit"
						disabled={busy}
						className="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
					>
						{busy ? "Signing in…" : "Sign in"}
					</button>
				</form>
			</div>
		</div>
	);
}