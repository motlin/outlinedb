import {afterAll, expect} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";

export const sleep = async (ms: number): Promise<void> =>
	new Promise((resolve) =>
	{
		setTimeout(resolve, ms);
	});

// Status polls are cheap in-process fetches, so poll often; each loop keeps its overall wait budget.
export const POLL_MS = 10;

export function uuid(n: number): string
{
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function makeNodes(count: number, rename = new Map<number, string>())
{
	return Array.from(
		{
			length: count,
		},
		(_, i) => (
		{
			id: uuid(i + 1),
			name: rename.get(i) ?? `node ${i}`,
			note: null,
			parent_id: i < 10 ? null : uuid((i % 10) + 1),
			priority: i,
			createdAt: 1000 + i,
			modifiedAt: 2000 + i,
		}),
	);
}

export interface SyncStatus
{
	phase: string;
	applied: number;
	nextAlarmAt: number | null;
	lastResult:
	{
		status: string;
		totalNodes?: number;
		nodesAdded?: number;
		nodesUpdated?: number;
		nodesUnchanged?: number;
		nodesPhasedOut?: number;
		exportKey?: string;
		internalSyncError?: string;
		durationMs?: number;
		finishedAt?: number;
		rowsWritten?: number;
	} | null;
	outbox:
	{
		pending: number;
		oldestEnqueuedAt: string | null;
		lastError: string | null;
	};
}

/** The batch size the tests run the import with. */
const BATCH = 20;

export const bindings =
{
	ACCESS_DEV_IDENTITY: "dev",
	OUTLINEDB_ENV_OWNERS: "dev",
	WORKFLOWY_API_KEY: "fake-key-value",
	WORKFLOWY_API_URL: "http://upstream.test",
};

export async function status(h: Harness): Promise<SyncStatus>
{
	const response = await h.mf.dispatchFetch("http://localhost/api/admin/sync");
	expect(response.status).toBe(200);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return (await readJson(response)) as SyncStatus;
}

export async function runToIdle(h: Harness, previousFinished = 0, path = "/api/admin/sync"): Promise<SyncStatus>
{
	const post = await h.mf.dispatchFetch(
		`http://localhost${path}`,
		{
			method: "POST",
		},
	);
	expect(post.status).toBe(202);
	for (let i = 0; i < 30_000 / POLL_MS; i++)
	{
		const current = await status(h);
		if (
			current.phase === "idle" &&
			current.lastResult !== null &&
			current.applied === 0 &&
			(i > 0 || previousFinished === 0)
		)
		{
			return current;
		}
		await sleep(POLL_MS);
	}
	throw new Error("sync did not finish");
}

export async function liveIds(h: Harness): Promise<string[]>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__live-ids");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test reads its own endpoint
	return response.json();
}

/** Bring the scheduled sync's due time forward to now, so the Durable Object's alarm fires it without the wait. */
export async function runScheduledSyncNow(h: Harness): Promise<void>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__sync-due-now");
	expect(response.status).toBe(204);
}

/** How many node_content rows share each system time, in system-time order. */
export async function rowsPerSystemTime(h: Harness): Promise<unknown>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__system-froms");
	return response.json();
}

interface SyncTables
{
	runs:
	{
		phase: string;
		applied: number;
		status: string | null;
		live: number;
	}[];
	runSystemFroms: number;
	seedRequests:
	{
		live: number;
		ordered: number;
	}[];
}

/** The sync job's own temporal tables: every run version and the seed requests. */
export async function syncTables(h: Harness): Promise<SyncTables>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__sync-tables");
	return response.json();
}

/** Rows the Durable Object's SQLite has written since it started, index rows included, as Cloudflare bills them. */
export async function rowsWritten(h: Harness): Promise<number>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__rows-written");
	const body = await response.json<
	{
		rowsWritten: number;
	}>();
	return body.rowsWritten;
}

export async function accountRows(h: Harness): Promise<unknown>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__account");
	return response.json();
}

export async function files(h: Harness): Promise<unknown>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__files");
	return response.json();
}

export async function internalMetadata(h: Harness): Promise<unknown>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__internal-metadata");
	return response.json();
}

interface TreeLog
{
	txId: string | null;
	mirrors:
	{
		mirror_id: string;
		original_id: string;
	}[];
}

export async function treeLog(h: Harness): Promise<TreeLog>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
	const response = await ns.get(ns.idFromName("dev")).fetch("http://localhost/__tree-log");
	return response.json();
}

/** One `/push_and_poll` result, as the server sends it. */
export function pollResult(txId: string, extra: Record<string, unknown> = {}): Response
{
	return Response.json(
		{
			results: [
				{
					new_most_recent_operation_transaction_id: txId,
					...extra,
				},
			],
		},
	);
}

/** The transaction id a `/push_and_poll` form started from. */
function startTxId(body: string): string
{
	const data: unknown = JSON.parse(new URLSearchParams(body).get("push_poll_data") ?? "[]");
	const first: unknown = Array.isArray(data) ? data[0] : undefined;
	return typeof first === "object" && first !== null && "most_recent_operation_transaction_id" in first
		? String(first.most_recent_operation_transaction_id)
		: "";
}

export const internalAuthBindings =
{
	WORKFLOWY_USERNAME: "alice@example.com",
	WORKFLOWY_PASSWORD: "hunter2",
};

/** One node of a fake `/api/v1/nodes-export` answer. */
type UpstreamNode = ReturnType<typeof makeNodes>[number];

/**
 * A fake workflowy.com that each test steers through its mutable fields, and the harnesses started against it. Each
 * sync test file builds its own, so the files run in parallel; it stops every harness a test left running after the file.
 */
interface FakeUpstream
{
	current: UpstreamNode[];
	exportCalls: number;
	rateLimit: boolean;
	exportFails: boolean;
	treeData: (() => Response) | undefined;
	pushAndPoll: () => Response;
	exportGate: Promise<void> | undefined;
	exportReached: (() => void) | undefined;
	treeGate: Promise<void> | undefined;
	treeReached: (() => void) | undefined;
	readonly internalCalls: string[];
	readonly pollStarts: string[];
	readonly auths: (string | null)[];
	start(persistDir?: string, extra?: Record<string, string>): Promise<Harness>;
	stop(h: Harness, keepData?: boolean): Promise<void>;
}

export function fakeUpstream(): FakeUpstream
{
	const open = new Set<Harness>();
	const up: FakeUpstream =
	{
		current: makeNodes(50),
		exportCalls: 0,
		rateLimit: false,
		exportFails: false,
		treeData: undefined,
		pushAndPoll: () => pollResult("1"),
		exportGate: undefined,
		exportReached: undefined,
		treeGate: undefined,
		treeReached: undefined,
		internalCalls: [],
		pollStarts: [],
		auths: [],
		async stop(h: Harness, keepData = false): Promise<void>
		{
			open.delete(h);
			await h.dispose(keepData);
		},
		async start(persistDir?: string, extra: Record<string, string> = {}): Promise<Harness>
		{
			const started = await startHarness(
				"./probe-entry.ts",
				"ProbeStore",
				persistDir,
				{
					...bindings,
					// Batches of 20 instead of production's 2000, so a 50-node export spans three batches.
					SYNC_BATCH_SIZE: String(BATCH),
					...extra,
				},
				{
					outboundService: async (request: Request): Promise<Response> =>
					{
						const url = new URL(request.url);
						if (url.pathname === "/push_and_poll")
						{
							up.internalCalls.push(url.pathname);
							up.pollStarts.push(startTxId(await request.text()));
							return up.pushAndPoll();
						}
						if (url.pathname === "/api/v1/nodes-export")
						{
							up.exportCalls++;
							up.auths.push(request.headers.get("authorization"));
							up.exportReached?.();
							await up.exportGate;
							if (up.exportFails)
							{
								return new Response(
									"export broke",
									{
										status: 500,
									},
								);
							}
							if (up.rateLimit)
							{
								return new Response(
									"slow down",
									{
										status: 429,
										headers:
										{
											"retry-after": "120",
										},
									},
								);
							}
							return Response.json(
								{
									nodes: up.current,
								},
							);
						}
						if (
							url.pathname === "/ajax_login" ||
							url.pathname === "/get_tree_data/" ||
							url.pathname === "/get_initialization_data"
						)
						{
							up.internalCalls.push(url.pathname);
							if (url.pathname === "/ajax_login")
							{
								return new Response(
									"{}",
									{
										status: 200,
										headers:
										{
											"set-cookie": "sessionid=abc; Path=/",
										},
									},
								);
							}
							if (url.pathname === "/get_initialization_data")
							{
								return Response.json(
									{
										projectTreeData:
										{
											mainProjectTreeInfo:
											{
												dateJoinedTimestampInSeconds: 1_400_000_000,
												initialMostRecentOperationTransactionId: "1",
											},
										},
										user:
										{
											id: 123,
										},
									},
								);
							}
							up.treeReached?.();
							await up.treeGate;
							return (
								up.treeData?.() ??
								new Response(
									"no tree data",
									{
										status: 500,
									},
								)
							);
						}
						return new Response(
							`unexpected ${url.pathname}`,
							{
								status: 500,
							},
						);
					},
				},
			);
			open.add(started);
			return started;
		},
	};
	afterAll(async () =>
	{
		await Promise.all([...open].map(async (h) => up.stop(h)));
	});
	return up;
}
