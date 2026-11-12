import {describe, expect, it} from "vite-plus/test";
import {installStaleModuleReload} from "../src/client/stale-module-reload.js";

type ErrorListener = (event: {error: unknown}) => void;

/** A window whose error listeners the test fires, whose timers run on demand, and whose reloads are counted. */
function fakeWindow(stored: Record<string, string> = {}, now = 1000)
{
	const listeners: ErrorListener[] = [];
	const timers:
	{
		run: () => void;
		ms: number;
	}[] = [];
	const errors: unknown[][] = [];
	let reloads = 0;
	const win =
	{
		addEventListener(type: "error", listener: ErrorListener)
		{
			listeners.push(listener);
		},
		setTimeout(run: () => void, ms: number)
		{
			timers.push(
				{
					run,
					ms,
				},
			);
			return 0;
		},
		location:
		{
			reload()
			{
				reloads += 1;
			},
		},
		sessionStorage:
		{
			getItem: (key: string) => stored[key] ?? null,
			setItem(key: string, value: string)
			{
				stored[key] = value;
			},
		},
		console:
		{
			error(...args: unknown[])
			{
				errors.push(args);
			},
		},
		Date:
		{
			now: () => now,
		},
	};
	return {
		win,
		stored,
		fire(error: unknown)
		{
			for (const listener of listeners)
			{
				listener(
					{
						error,
					},
				);
			}
		},
		runTimers()
		{
			for (const timer of timers.splice(0))
			{
				timer.run();
			}
		},
		state: () => (
		{
			timers: timers.map((timer) => timer.ms),
			reloads,
			errors,
		}),
	};
}

const LINK_ERROR = new SyntaxError(
	"The requested module '/components/left-bar-files-list.tsx?t=1' does not provide an export named 'FilesListArrow'",
);

describe("the dev-only stale module reload", () =>
{
	it("reloads a second after a module fails to link against a renamed export", () =>
	{
		const page = fakeWindow();
		installStaleModuleReload(page.win);
		page.fire(LINK_ERROR);
		const scheduled = page.state();
		page.runTimers();
		expect(
			{
				scheduled,
				after: page.state(),
				stored: page.stored,
			},
		).toStrictEqual(
			{
				scheduled:
				{
					timers: [1000],
					reloads: 0,
					errors: [],
				},
				after:
				{
					timers: [],
					reloads: 1,
					errors: [],
				},
				stored:
				{
					"stale-module-reload": JSON.stringify(
						{
							since: 1000,
							count: 1,
						},
					),
				},
			},
		);
	});

	it("doubles the wait for each reload already in the burst", () =>
	{
		const page = fakeWindow(
			{
				"stale-module-reload": JSON.stringify(
					{
						since: 0,
						count: 2,
					},
				),
			},
			5000,
		);
		installStaleModuleReload(page.win);
		page.fire(LINK_ERROR);
		page.fire(LINK_ERROR);
		expect(
			{
				state: page.state(),
				stored: page.stored,
			},
		).toStrictEqual(
			{
				state:
				{
					timers: [4000],
					reloads: 0,
					errors: [],
				},
				stored:
				{
					"stale-module-reload": JSON.stringify(
						{
							since: 0,
							count: 3,
						},
					),
				},
			},
		);
	});

	it("ignores errors that are not a failed module link", () =>
	{
		const page = fakeWindow();
		installStaleModuleReload(page.win);
		page.fire(new TypeError("x is undefined"));
		page.fire(new SyntaxError("Unexpected token '<'"));
		expect(page.state()).toStrictEqual(
			{
				timers: [],
				reloads: 0,
				errors: [],
			},
		);
	});

	it("gives up after five reloads within a minute so a truly missing export does not loop", () =>
	{
		const page = fakeWindow(
			{
				"stale-module-reload": JSON.stringify(
					{
						since: 0,
						count: 5,
					},
				),
			},
			30_000,
		);
		installStaleModuleReload(page.win);
		page.fire(LINK_ERROR);
		expect(page.state()).toStrictEqual(
			{
				timers: [],
				reloads: 0,
				errors: [["[stale-module-reload] still failing after 5 reloads; reload by hand once the files settle"]],
			},
		);
	});

	it("starts a fresh count once the last burst is a minute old", () =>
	{
		const page = fakeWindow(
			{
				"stale-module-reload": JSON.stringify(
					{
						since: 0,
						count: 5,
					},
				),
			},
			61_000,
		);
		installStaleModuleReload(page.win);
		page.fire(LINK_ERROR);
		page.runTimers();
		expect(
			{
				state: page.state(),
				stored: page.stored,
			},
		).toStrictEqual(
			{
				state:
				{
					timers: [],
					reloads: 1,
					errors: [],
				},
				stored:
				{
					"stale-module-reload": JSON.stringify(
						{
							since: 61_000,
							count: 1,
						},
					),
				},
			},
		);
	});
});
