/**
 * The OutlineDB auth screens, and `/welcome`, the signup wizard step the verify-email link lands on: served outside the
 * outline, and never redirected to login themselves.
 */
const AUTH_PATHS = new Set(["/login", "/signup", "/verify-email", "/reset-password", "/welcome"]);

export function isAuthPath(pathname: string): boolean
{
	return AUTH_PATHS.has(pathname);
}

/** `/login`, remembering the whole current location (the outline's zoom lives in the hash) as `next`. */
export function loginUrl(location: Pick<Location, "pathname" | "search" | "hash">): string
{
	return `/login?next=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`;
}

/** The query parameter that opens Settings at a section once the outline loads, as `/?settings=Workflowy`. */
const SETTINGS_PARAM = "settings";

/** `path` (a safe next) with Settings opened at `section`, keeping its hash, which holds the outline's zoom. */
export function withSettingsOpen(path: string, section: string): string
{
	const url = new URL(path, "http://origin");
	url.searchParams.set(SETTINGS_PARAM, section);
	return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Open Settings at the section the URL names, then drop the parameter so a reload or a shared link does not reopen
 * it.
 */
export function openSettingsFromUrl(
	location: Pick<Location, "href">,
	history: Pick<History, "state" | "replaceState">,
	openSettings: (section: string) => void,
): void
{
	const url = new URL(location.href);
	const section = url.searchParams.get(SETTINGS_PARAM);
	if (section === null)
	{
		return;
	}
	url.searchParams.delete(SETTINGS_PARAM);
	history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
	openSettings(section);
}

/** `next` when it is a path on this origin that is not an auth screen, else `/`: a login link must never send the user off-site. */
export function safeNext(next: string | null): string
{
	if (next === null || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\"))
	{
		return "/";
	}
	return isAuthPath(new URL(next, "http://origin").pathname) ? "/" : next;
}

/** Sends the user to login after a 401, unless they are already on an auth screen (where a 401 would loop). */
export function redirectToLogin(
	location: Pick<Location, "pathname" | "search" | "hash" | "assign"> = globalThis.location,
): void
{
	if (!isAuthPath(location.pathname))
	{
		location.assign(loginUrl(location));
	}
}

/**
 * After a request whose status the page cannot see (a refused WebSocket upgrade), asks `/health`, which needs the same
 * sign-in, and goes to login on a 401.
 */
export async function redirectIfSignedOut(): Promise<void>
{
	const response = await fetch("/health").catch(() => {});
	if (response?.status === 401)
	{
		redirectToLogin();
	}
}
