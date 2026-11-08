/** The OutlineDB auth screens: served outside the outline, and never redirected to login themselves. */
const AUTH_PATHS = new Set(["/login", "/signup", "/verify-email", "/reset-password"]);

export function isAuthPath(pathname: string): boolean {
	return AUTH_PATHS.has(pathname);
}

/** `/login`, remembering the whole current location (the outline's zoom lives in the hash) as `next`. */
export function loginUrl(location: Pick<Location, "pathname" | "search" | "hash">): string {
	return `/login?next=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`;
}

/** `next` when it is a path on this origin that is not an auth screen, else `/`: a login link must never send the user off-site. */
export function safeNext(next: string | null): string {
	if (next === null || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
		return "/";
	}
	return isAuthPath(new URL(next, "http://origin").pathname) ? "/" : next;
}

/** Sends the user to login after a 401, unless they are already on an auth screen (where a 401 would loop). */
export function redirectToLogin(
	location: Pick<Location, "pathname" | "search" | "hash" | "assign"> = globalThis.location,
): void {
	if (!isAuthPath(location.pathname)) {
		location.assign(loginUrl(location));
	}
}

/**
 * After a request whose status the page cannot see (a refused WebSocket upgrade), asks `/health`, which needs the same
 * sign-in, and goes to login on a 401.
 */
export async function redirectIfSignedOut(): Promise<void> {
	const response = await fetch("/health").catch(() => {});
	if (response?.status === 401) {
		redirectToLogin();
	}
}
