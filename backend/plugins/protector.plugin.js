import { Elysia } from "elysia";

export const ProtectorPlugin = new Elysia({
	name: "ProtectorPlugin",
}).onBeforeHandle(({ user, set }) => {
	if (!user) {
		set.status = 401;
		return { success: false, message: "Unauthorized" };
	}
});