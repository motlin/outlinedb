export type ServerMode = "mirror" | "standalone";

/** Settings the server reads, parsed once by the host so routers never touch `process.env`. */
export interface ServerConfig
{
	/**
	 * Where node writes go: "mirror" writes through to workflowy.com and persists the result locally; "standalone"
	 * has no workflowy.com behind it and writes straight into the local node tables.
	 */
	mode: ServerMode;
	/** The Workflowy API key, or undefined when write operations are unavailable. */
	apiKey?: string;
	/** Override for the Workflowy API base URL (tests, proxies). */
	apiUrl?: string;
	/** The account email shown by `GET /api/v1/account`. */
	accountEmail: string;
	/** Whether Drizzle logs every SQL query. */
	sqlQueryLogging: boolean;
	/** Whether `POST /api/v1/calendar/day/:dateId/ensure` may create day nodes. */
	calendarEnsureEnabled: boolean;
	/** Whether `PUT /api/v1/calendar/layout` may restructure the calendar. */
	calendarLayoutEnabled: boolean;
	features:
	{
		embeddings: boolean;
		treeSnapshot: boolean;
	};
}

/** {@link ServerConfig} plus the settings only the Node host has. */
export interface NodeServerConfig extends ServerConfig
{
	/** The SQLite cache file (`OUTLINEDB_DB_PATH`), or undefined for `outlinedb.sqlite` in `cwd` in WAL mode. */
	dbPath?: string;
}

const MODE_USAGE =
	'OUTLINEDB_MODE must be set to "mirror" (write through to workflowy.com) or "standalone" (local writes only)';

/**
 * Parse {@link NodeServerConfig} from a Node-style environment; every Node host setting is read here, one env var
 * each. Throws when `OUTLINEDB_MODE` is unset or unknown, or is "mirror" without `WORKFLOWY_API_KEY`, so the host
 * fails at startup instead of silently writing locally or answering 500 per write.
 */
export function readNodeConfig(env: Record<string, string | undefined>): NodeServerConfig
{
	const mode = readMode(env.OUTLINEDB_MODE);
	const apiKey = nonEmpty(env.WORKFLOWY_API_KEY);
	if (mode === "mirror" && apiKey === undefined)
	{
		throw new Error(
			"OUTLINEDB_MODE=mirror needs WORKFLOWY_API_KEY to write through to workflowy.com; it is unset.",
		);
	}
	return {
		mode,
		apiKey,
		apiUrl: nonEmpty(env.WORKFLOWY_API_URL),
		accountEmail: env.WORKFLOWY_USERNAME ?? "",
		dbPath: nonEmpty(env.OUTLINEDB_DB_PATH),
		sqlQueryLogging: env.OUTLINEDB_SQL_QUERY_LOGGING === "true",
		calendarEnsureEnabled: env.CALENDAR_ENSURE_ENABLED !== "false",
		calendarLayoutEnabled: env.CALENDAR_LAYOUT_ENABLED !== "false",
		features:
		{
			embeddings: env.OUTLINEDB_EMBEDDINGS !== "false",
			treeSnapshot: env.TREE_SNAPSHOT !== "false",
		},
	};
}

function readMode(value: string | undefined): ServerMode
{
	if (value === "mirror" || value === "standalone")
	{
		return value;
	}
	throw new Error(
		`${MODE_USAGE}; ${value === undefined || value === "" ? "it is unset" : `got ${JSON.stringify(value)}`}.`,
	);
}

function nonEmpty(value: string | undefined): string | undefined
{
	return value === "" ? undefined : value;
}
