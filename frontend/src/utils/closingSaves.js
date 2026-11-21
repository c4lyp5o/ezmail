// Close-time server draft saves still in flight, per local draft key (one per
// mailbox). A composer opened meanwhile restores the local draft only after
// that save settles, so it picks up the new server UID and attachment refs.
const pending = new Map();

// `settled` must never reject.
export function trackClosingSave(key, settled) {
	pending.set(key, settled);
	settled.finally(() => {
		if (pending.get(key) === settled) pending.delete(key);
	});
}

export const closingSave = (key) => pending.get(key);

// Tests: forget saves left over from a previous case.
export function resetClosingSaves() {
	pending.clear();
}
