import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { apiCall } from "../utils/apiCall.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
	const [user, setUser] = useState(null);
	const [loading, setLoading] = useState(true);

	const checkAuth = useCallback(async () => {
		try {
			const res = await apiCall.get("/me");
			setUser(res.data);
			return true;
		} catch {
			setUser(null);
			return false;
		}
	}, []);

	useEffect(() => {
		(async () => {
			await checkAuth();
			setLoading(false);
		})();
	}, [checkAuth]);

	const login = useCallback(
		async (mailbox, password, rememberMe) => {
			const res = await apiCall.post("/login", { mailbox, password, rememberMe });
			await checkAuth();
			return res;
		},
		[checkAuth],
	);

	const logout = useCallback(async () => {
		await apiCall.post("/logout");
		setUser(null);
	}, []);

	return (
		<AuthContext.Provider value={{ user, loading, login, logout }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	return useContext(AuthContext);
}