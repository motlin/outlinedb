/** The window parts the reload reads, so tests can hand it a fake. */
export interface ReloadWindow
{
	addEventListener(type: "error", listener: (event: {error: unknown}) => void): void;
	setTimeout(run: () => void, ms: number): unknown;
	location:
	{
		reload(): void;
	};
	sessionStorage:
	{
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
	};
	console:
	{
		error(...args: unknown[]): void;
	};
	Date:
	{
		now(): number;
	};
}

const KEY = "stale-module-reload";
/** The first reload's wait; each later one in the burst doubles it, so five span the ~30s a rebase can take. */
const DELAY_MS = 1000;
const MAX_RELOADS = 5;
const WINDOW_MS = 60_000;

interface Burst
{
	since: number;
	count: number;
}

function isBurst(value: unknown): value is Burst
{
	return (
		typeof value === "object" &&
		value !== null &&
		"since" in value &&
		"count" in value &&
		typeof value.since === "number" &&
		typeof value.count === "number"
	);
}

function readBurst(win: ReloadWindow, now: number): Burst
{
	try
	{
		const burst: unknown = JSON.parse(win.sessionStorage.getItem(KEY) ?? "null");
		return isBurst(burst) && now - burst.since < WINDOW_MS
			? burst
			:
				{
					since: now,
					count: 0,
				};
	}
	catch
	{
		return {
			since: now,
			count: 0,
		};
	}
}

/**
 * Dev only: reload the page when a module fails to link against an export its dependency no longer has. A git
 * checkout or rebase writes files one at a time; a reload Vite triggers mid-write can load a new module with a stale
 * importer, and that page stays blank because its importer never registered for HMR. Reloading once the files settle
 * recovers it; five reloads (1s, 2s, 4s, 8s, 16s apart) within a minute mean the export is truly missing, so it stops and says so.
 */
export function installStaleModuleReload(win: ReloadWindow): void
{
	let scheduled = false;
	win.addEventListener("error", ({error}) =>
	{
		if (
			scheduled ||
			!(error instanceof SyntaxError) ||
			!error.message.includes("does not provide an export named")
		)
		{
			return;
		}
		const now = win.Date.now();
		const burst = readBurst(win, now);
		if (burst.count >= MAX_RELOADS)
		{
			win.console.error(
				`[stale-module-reload] still failing after ${MAX_RELOADS} reloads; reload by hand once the files settle`,
			);
			return;
		}
		try
		{
			win.sessionStorage.setItem(
				KEY,
				JSON.stringify(
					{
						since: burst.since,
						count: burst.count + 1,
					},
				),
			);
		}
		catch
		{
			// Without storage the burst cap cannot hold, and an unbounded reload loop is worse than a blank page.
			return;
		}
		scheduled = true;
		win.setTimeout(
			() =>
			{
				win.location.reload();
			},
			DELAY_MS * 2 ** burst.count,
		);
	});
}
