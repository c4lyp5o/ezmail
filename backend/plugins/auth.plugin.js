import { Elysia } from "elysia";
import { getSession } from "../services/session.service.js";

export const SESSION_COOKIE = "ezmail_session";

// Resolves the authenticated user ({ mailbox, password }) from the session
// cookie, or null. Handlers call this directly rather than trusting a
// derived value.
export function getUser(cookie) {
	return getSession(cookie?.[SESSION_COOKIE]?.value);
}

// Derives the authenticated user for guard hooks (ProtectorPlugin).
export const AuthPlugin = new Elysia({ name: "AuthPlugin" }).derive(
	({ cookie }) => ({ user: getUser(cookie) }),
);
