export type ServerMode = "mirror" | "standalone";

/** Settings the server reads, parsed once by the host so routers never touch `process.env`. */
export interface ServerConfig {
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
	features: {embeddings: boolean; treeSnapshot: boolean};
}

/** Parse {@link ServerConfig} from a Node-style environment. */
export function readNodeConfig(env: Record<string, string | undefined>): ServerConfig {
	return {
		mode: env.WORKFLOWY_API_KEY ? "mirror" : "standalone",
		apiKey: env.WORKFLOWY_API_KEY,
		apiUrl: env.WORKFLOWY_API_URL,
		accountEmail: env.WORKFLOWY_USERNAME ?? "",
		sqlQueryLogging: env.OUTLINEDB_SQL_QUERY_LOGGING === "true",
		calendarEnsureEnabled: env.CALENDAR_ENSURE_ENABLED !== "false",
		calendarLayoutEnabled: env.CALENDAR_LAYOUT_ENABLED !== "false",
		features: {embeddings: true, treeSnapshot: true},
	};
}
