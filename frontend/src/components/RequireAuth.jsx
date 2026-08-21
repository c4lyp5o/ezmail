import { Navigate } from "react-router-dom";
import { useAuth } from "../context/auth.jsx";

// Protects a route: shows a loader while auth is being checked, then redirects
// to /login if unauthenticated (covers the "poke /mail with no session →
// Unauthorized" case).
export default function RequireAuth({ children }) {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="flex h-screen items-center justify-center text-ink-muted">
				Loading…
			</div>
		);
	}

	if (!user) return <Navigate to="/login" replace />;
	return children;
}
