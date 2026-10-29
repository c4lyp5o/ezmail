// In-memory failed-attempt limiter (fixed window per key). Process-local: it
// resets on restart and is not shared across instances — fine for the single
// pm2 fork process ezmail runs as (ecosystem.config.js).
export function createLimiter({ max, windowMs, maxKeys = 10000 }) {
	const hits = new Map();

	const live = (key, now) => {
		const e = hits.get(key);
		if (e && now - e.start >= windowMs) {
			hits.delete(key);
			return null;
		}
		return e || null;
	};

	return {
		// Seconds until the key may try again, or 0 when not blocked.
		retryAfter(key, now = Date.now()) {
			const e = live(key, now);
			if (!e || e.count < max) return 0;
			return Math.ceil((e.start + windowMs - now) / 1000);
		},

		fail(key, now = Date.now()) {
			const e = live(key, now);
			if (e) {
				e.count++;
				return;
			}
			// Bound memory under key spraying: drop expired entries first, then
			// the oldest if still full.
			if (hits.size >= maxKeys) {
				for (const k of hits.keys()) live(k, now);
				if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
			}
			hits.set(key, { start: now, count: 1, pending: 0 });
		},

		reset(key) {
			const e = hits.get(key);
			if (e?.pending) e.count = e.pending;
			else hits.delete(key);
		},

		// Reserve a slot synchronously before asynchronous credential checks.
		// Settling a success clears completed failures, but never other in-flight
		// attempts. The entry identity prevents stale completions affecting a new window.
		reserve(key, now = Date.now()) {
			const wait = this.retryAfter(key, now);
			if (wait) return { wait };
			this.fail(key, now);
			const entry = hits.get(key);
			entry.pending++;
			let settled = false;
			return { wait: 0, settle: (success) => {
				if (settled) return;
				settled = true;
				if (hits.get(key) !== entry) return;
				entry.pending--;
				if (success) this.reset(key);
			} };
		},
	};
}

const MINUTE = 60 * 1000;

// TOTP codes are 6 digits: 5 misses per 15 min makes brute force infeasible.
export const discoveryLimiter = createLimiter({ max: 30, windowMs: 15 * MINUTE });

export const codeLimiter = createLimiter({ max: 5, windowMs: 15 * MINUTE });

// Password login is also checked by the IMAP server; this just stops ezmail
// being used as an unthrottled password-guessing proxy.
export const loginLimiter = createLimiter({ max: 10, windowMs: 15 * MINUTE });

export const limitKey = (mailbox) => String(mailbox).toLowerCase().trim();
