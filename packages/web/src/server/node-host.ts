import type BetterSqlite3 from "better-sqlite3";
import type {ChangeSource, TreeHost, TreeScheduler} from "./tree-snapshot.js";

/** Node implementations of the snapshot's host seams, over a better-sqlite3 connection. */

function nodeChangeSource(sqlite: BetterSqlite3.Database): ChangeSource
{
	return {
		dataVersion: () =>
			String(
				sqlite.pragma(
					"data_version",
					{
						simple: true,
					},
				),
			),
		isOpen: () => sqlite.open,
	};
}

/** `setTimeout` timers that do not keep the process alive. */
const nodeScheduler: TreeScheduler =
{
	setTimer(run, delayMs)
	{
		const timer = setTimeout(run, delayMs);
		timer.unref();
		return () =>
		{
			clearTimeout(timer);
		};
	},
};

export function nodeTreeHost(sqlite: BetterSqlite3.Database): TreeHost
{
	return {
		changeSource: nodeChangeSource(sqlite),
		scheduler: nodeScheduler,
	};
}
