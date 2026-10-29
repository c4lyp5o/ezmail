import crypto from "node:crypto";

// Short-lived pool of authenticated IMAP connections, per mailbox + password.
// Every API call used to connect, log in and log out; reusing a connection for
// a few seconds removes that round trip and keeps ezmail under servers'
// per-user connection limits (Dovecot defaults to 10 per IP).
//
// A connection is checked out exclusively, so callers keep imapflow's usual
// one-command-at-a-time guarantees. Connections that failed are discarded.
// IMAP_POOL_IDLE_MS=0 disables reuse (each call logs out when done).

const MAX_PER_MAILBOX = 3;
const idleMs = () => Number(process.env.IMAP_POOL_IDLE_MS ?? 30_000);

// Bounded waits: a hung mail server must not tie requests up for minutes.
export const REQUEST_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 };

export function createPool(build) {
	const entries = new Map();
	const close = (client) => client.logout().catch(() => {});
	const keyOf = ({ mailbox, password }) =>
		`${mailbox.trim().toLowerCase()}\0${crypto.createHash("sha256").update(password).digest("hex")}`;

	function settle(key, entry) {
		if (!entry.open && !entry.idle.length && !entry.waiters.length) entries.delete(key);
	}

	function drop(key, entry, client) {
		entry.open--;
		close(client);
		entry.waiters.shift()?.();
		settle(key, entry);
	}

	async function acquire(user) {
		const key = keyOf(user);
		const entry = entries.get(key) ?? { idle: [], open: 0, waiters: [] };
		entries.set(key, entry);
		for (;;) {
			const slot = entry.idle.pop();
			if (slot) {
				clearTimeout(slot.timer);
				if (slot.client.usable !== false) return { key, entry, client: slot.client };
				drop(key, entry, slot.client);
				continue;
			}
			if (entry.open < MAX_PER_MAILBOX) {
				entry.open++;
				const client = build(user, REQUEST_TIMEOUTS);
				// Idle sockets can time out between uses; that must not crash the process.
				client.on("error", () => {});
				try {
					await client.connect();
				} catch (err) {
					drop(key, entry, client);
					throw err;
				}
				return { key, entry, client };
			}
			await new Promise((resolve) => entry.waiters.push(resolve));
		}
	}

	function release({ key, entry, client }, broken) {
		const ttl = idleMs();
		if (broken || ttl <= 0 || client.usable === false) return drop(key, entry, client);
		const slot = { client };
		slot.timer = setTimeout(() => {
			entry.idle.splice(entry.idle.indexOf(slot), 1);
			drop(key, entry, client);
		}, ttl);
		slot.timer.unref?.();
		entry.idle.push(slot);
		entry.waiters.shift()?.();
	}

	return {
		// Runs fn with an exclusive connection for the user.
		async use(user, fn) {
			const lease = await acquire(user);
			let broken = false;
			try {
				return await fn(lease.client);
			} catch (err) {
				broken = true;
				throw err;
			} finally {
				release(lease, broken);
			}
		},
		// Logs out every idle connection (shutdown and tests).
		async closeIdle() {
			for (const [key, entry] of entries) {
				for (const slot of entry.idle.splice(0)) {
					clearTimeout(slot.timer);
					entry.open--;
					await close(slot.client);
				}
				settle(key, entry);
			}
		},
	};
}
