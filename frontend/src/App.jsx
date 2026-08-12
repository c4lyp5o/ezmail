import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/auth.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import MailPage from "./pages/MailPage.jsx";
import RequireAuth from "./RequireAuth.jsx";

function Gate() {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="flex h-screen items-center justify-center text-zinc-500">
				Loading…
			</div>
		);
	}

	if (!user) return <Navigate to="/login" replace />;
	return <Navigate to="/mail" replace />;
}

export default function App() {
	return (
		<AuthProvider>
			<Routes>
				<Route path="/" element={<Gate />} />
				<Route path="/login" element={<LoginPage />} />
				<Route
					path="/mail/*"
					element={
						<RequireAuth>
							<MailPage />
						</RequireAuth>
					}
				/>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</AuthProvider>
	);
}