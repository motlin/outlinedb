import {newSystemTimestamp} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every whole-tree `/get_tree_data/` download (about 54 MB live) this object made, temporal like every other table:
 * one version per download, never changed after. Workers report no heap size, so peak memory is not recorded.
 */
const TREE_DOWNLOADS_TABLE = `
CREATE TABLE IF NOT EXISTS tree_downloads (
	download_id TEXT NOT NULL,
	cause TEXT NOT NULL,
	outcome TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	bytes INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (download_id, system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS tree_downloads_system_to_idx ON tree_downloads (download_id, system_to);
CREATE INDEX IF NOT EXISTS tree_downloads_closed_at_idx ON tree_downloads (system_to)
	WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

/** Why the tree was downloaded: the per-account import is the one whole-tree read the Worker makes. */
export type TreeDownloadCause = "import";

/** One finished download: `error` when it failed part way, with the bytes it read before failing. */
export interface TreeDownload
{
	cause: TreeDownloadCause;
	outcome: "ok" | "error";
	startedAt: number;
	durationMs: number;
	bytes: number;
}

/** What syncStatus reports of the downloads. */
export interface TreeDownloadCounts
{
	total: number;
	last24Hours: number;
	bytesLast24Hours: number;
	/** The newest download, or null before the first. */
	last: Omit<TreeDownload, "startedAt"> | null;
}

/**
 * Records each whole-tree download in the object's SQLite and, when the Worker has the binding, as one Analytics
 * Engine data point (blobs: cause, outcome; doubles: bytes, duration ms; index: the object), which the daily usage
 * alert sums across every account.
 */
export class TreeDownloadLog
{
	constructor(
		private readonly sql: SqlStorage,
		private readonly objectId: string,
		private readonly analytics?: AnalyticsEngineDataset,
		private readonly now: () => number = Date.now,
	)
	{
		sql.exec(TREE_DOWNLOADS_TABLE);
	}

	record(download: TreeDownload): void
	{
		this.sql.exec(
			"INSERT INTO tree_downloads (download_id, cause, outcome, started_at, duration_ms, bytes, system_from, system_to) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			download.cause,
			download.outcome,
			download.startedAt,
			download.durationMs,
			download.bytes,
			newSystemTimestamp(),
			FAR_FUTURE_DATE,
		);
		this.analytics?.writeDataPoint(
			{
				blobs: [download.cause, download.outcome],
				doubles: [download.bytes, download.durationMs],
				indexes: [this.objectId],
			},
		);
	}

	counts(): TreeDownloadCounts
	{
		const since = this.now() - DAY_MS;
		const totals = this.sql
			.exec<
			{
				total: number;
				recent: number | null;
				recentBytes: number | null;
			}>(
				"SELECT count(*) AS total, sum(started_at >= ?) AS recent, sum(CASE WHEN started_at >= ? THEN bytes END) " +
					"AS recentBytes FROM tree_downloads WHERE system_to = ?",
				since,
				since,
				FAR_FUTURE_DATE,
			)
			.one();
		const last = this.sql
			.exec<
			{
				cause: string;
				outcome: string;
				duration_ms: number;
				bytes: number;
			}>(
				"SELECT cause, outcome, duration_ms, bytes FROM tree_downloads WHERE system_to = ? " +
					"ORDER BY started_at DESC LIMIT 1",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		return {
			total: totals.total,
			last24Hours: totals.recent ?? 0,
			bytesLast24Hours: totals.recentBytes ?? 0,
			last:
				last === undefined
					? null
					:
						{
							cause: causeOf(last.cause),
							outcome: last.outcome === "error" ? "error" : "ok",
							durationMs: last.duration_ms,
							bytes: last.bytes,
						},
		};
	}
}

function causeOf(value: string): TreeDownloadCause
{
	if (value === "import")
	{
		return value;
	}
	throw new Error(`Unknown tree download cause ${value}`);
}
