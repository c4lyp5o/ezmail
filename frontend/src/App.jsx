import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/auth.jsx";
import { ThemeProvider } from "./context/theme.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import MailPage from "./pages/MailPage.jsx";
import RequireAuth from "./components/RequireAuth.jsx";

function Gate() {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="flex h-screen items-center justify-center text-ink-muted">
				Loading…
			</div>
		);
	}

	if (!user) return <Navigate to="/login" replace />;
	return <Navigate to="/mail" replace />;
}

export default function App() {
	return (
		<ThemeProvider>
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
		</ThemeProvider>
	);
}
