import { Elysia } from "elysia";

// Decodes the authenticated mailbox from the JWT cookie. Handlers call this
// directly (mirroring eziarr's AuthService.me, which reads jwt + cookie itself
// rather than trusting a derived value).
export async function getUser(jwt, cookie) {
	try {
		const token = cookie.ezmail_access?.value;
		if (!token) return null;
		const payload = await jwt.verify(token);
		if (!payload?.mailbox || !payload?.password) return null;
		return { mailbox: payload.mailbox, password: payload.password };
	} catch {
		return null;
	}
}

// Derives the authenticated user for guard hooks (ProtectorPlugin). Same
// pattern as eziarr's AuthPlugin deriving isAdmin.
export const AuthPlugin = new Elysia({ name: "AuthPlugin" }).derive(
	async ({ jwt, cookie: c }) => {
		const user = await getUser(jwt, c);
		return { user };
	},
);