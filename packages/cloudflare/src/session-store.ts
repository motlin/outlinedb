import type {SessionCookieStore} from "@workflowy/shared/api";

/** The synchronous key-value surface of `DurableObjectStorage.kv`. */
export interface KvLike {
	get(key: string): string | undefined;
	put(key: string, value: string): void;
	delete(key: string): boolean;
}

const COOKIE_KEY = "workflowy-session-cookie";
const SEEDED_KEY = "workflowy-session-seeded";

/**
 * A session store over a Durable Object's key-value storage. The first use copies the
 * `WORKFLOWY_SESSION_COOKIE` binding in; after that the stored cookie wins, so a rotated
 * login survives restarts and a cleared session is not resurrected from the binding. With `seed: false` the store
 * neither seeds nor marks itself seeded, so a later owner store over the same storage still copies the binding in.
 */
export function kvSessionStore(
	kv: KvLike,
	seedCookie: string | undefined,
	{seed = true}: {seed?: boolean} = {},
): SessionCookieStore {
	if (seed && kv.get(SEEDED_KEY) === undefined) {
		kv.put(SEEDED_KEY, "1");
		if (seedCookie) {
			kv.put(COOKIE_KEY, seedCookie);
		}
	}
	return {
		read() {
			const cookie = kv.get(COOKIE_KEY);
			return cookie === undefined || cookie === "" ? undefined : cookie;
		},
		write(cookie) {
			kv.put(COOKIE_KEY, cookie);
		},
		clear() {
			kv.delete(COOKIE_KEY);
		},
	};
}
