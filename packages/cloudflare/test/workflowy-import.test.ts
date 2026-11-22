import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import type {ProbeStore} from "./probe-entry";
import {POLL_MS, sleep, uuid} from "./sync-upstream";

const PASSWORD = "correct-horse-battery";
/** The account's join date: every `/get_tree_data/` timestamp counts seconds from it. */
const JOINED = 1_500_000_000;

const PROJECTS = uuid(1);
const DONE = uuid(2);
const ORIGINAL = uuid(3);
const MIRROR = uuid(4);
const TARGET = uuid(5);
const REFERENCES = uuid(6);
const BACKLINK = uuid(7);
/** The expanded keys workflowy.com keeps for the account. */
const EXPANDED = ["1a2b3c4d", "5e6f7a8b"];

/** One account's whole tree as `/get_tree_data/` sends it: flat, parents by `prnt`, siblings ordered by `pr`. */
const TREE_ITEMS = [
	{
		id: PROJECTS,
		nm: "Projects",
		prnt: null,
		pr: 0,
		ct: 10,
		lm: 20,
	},
	{
		id: DONE,
		nm: "Finished task",
		no: "with a note",
		prnt: PROJECTS,
		pr: 0,
		ct: 11,
		lm: 21,
		cp: 31,
	},
	{
		id: ORIGINAL,
		nm: "Mirrored bullet",
		prnt: null,
		pr: 1,
		ct: 12,
		metadata:
		{
			mirror:
			{
				mirrorRootIds:
				{
					[MIRROR]: true,
				},
			},
			numbered_start: 3,
		},
	},
	{
		id: MIRROR,
		nm: "Mirrored bullet",
		prnt: PROJECTS,
		pr: 1,
		ct: 13,
		metadata:
		{
			mirror:
			{
				originalId: ORIGINAL,
				isMirrorRoot: true,
			},
		},
	},
	{
		id: TARGET,
		nm: "Linked from Projects",
		prnt: null,
		pr: 2,
		ct: 14,
	},
	{
		id: REFERENCES,
		nm: "",
		prnt: TARGET,
		pr: 0,
		ct: 15,
		metadata:
		{
			isReferencesRoot: true,
		},
	},
	{
		id: BACKLINK,
		nm: "Projects",
		prnt: REFERENCES,
		pr: 0,
		ct: 16,
		metadata:
		{
			backlink:
			{
				sourceID: PROJECTS,
				targetID: TARGET,
			},
		},
	},
];

describe("importing an account from workflowy.com over its stored session", () =>
{
	let harness: Harness;
	let logins = 0;
	/** Set to refuse every stored session, as workflowy.com does once one expires. */
	let sessionsExpired = false;
	const upstreamCalls: string[] = [];

	beforeAll(async () =>
	{
		harness = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				ACCESS_DEV_IDENTITY: "dev",
				OUTLINEDB_CREDENTIALS_KEY: "test-credentials-key",
				WORKFLOWY_API_URL: "http://upstream.test",
				// Batches of two, one per alarm run, so the seven-node tree spans several alarm runs and each resumes.
				SYNC_BATCH_SIZE: "2",
				SYNC_BATCHES_PER_TICK: "1",
			},
			{
				outboundService: (request: Request): Response =>
				{
					const url = new URL(request.url);
					upstreamCalls.push(url.pathname);
					if (url.pathname === "/ajax_login")
					{
						logins++;
						return new Response(
							"",
							{
								headers:
								{
									"set-cookie": `sessionid=upstream-session-${String(logins)}; Path=/; HttpOnly`,
								},
							},
						);
					}
					if (
						sessionsExpired ||
						request.headers.get("cookie") !== `sessionid=upstream-session-${String(logins)}`
					)
					{
						return new Response(
							null,
							{
								status: 302,
								headers:
								{
									location: "/login/",
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
										dateJoinedTimestampInSeconds: JOINED,
										initialMostRecentOperationTransactionId: "700",
									},
									rootProjectMetadata:
									{
										starring:
										{
											locations:
											{
												[PROJECTS.slice(-12)]: "None",
												[TARGET.slice(-12)]: "None",
											},
											order: `${PROJECTS.slice(-12)},${TARGET.slice(-12)}`,
										},
										color:
										{
											tags:
											{
												"#work": 3,
											},
										},
									},
								},
								user:
								{
									id: 123,
									email: "alice@example.com",
								},
								settings:
								{
									theme: "dark",
									saved_views_json: JSON.stringify([
										{
											zoomedProject:
											{
												projectid: PROJECTS.slice(-12),
											},
											searchQuery: "#work",
										},
									]),
								},
								features: [],
							},
						);
					}
					if (url.pathname === "/get_tree_data/")
					{
						return Response.json(
							{
								items: TREE_ITEMS,
								shared_projects: {},
								most_recent_operation_transaction_id: "701",
								server_expanded_projects_list: EXPANDED,
							},
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
		const stub = await store();
		await stub.provision(
			{
				userId: "dev",
				email: "alice@example.com",
				mode: "standalone",
			},
		);
	}, 60_000);
	afterAll(async () =>
	{
		await harness.dispose();
	});

	async function store(): Promise<DurableObjectStub<ProbeStore>>
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await harness.mf.getDurableObjectNamespace(
			"USER_STORE",
		)) as unknown as DurableObjectNamespace<ProbeStore>;
		return ns.getByName("dev");
	}

	async function send(
		path: string,
		method: string,
		body?: unknown,
	): Promise<
	{
		status: number;
		body: unknown;
	}>
	{
		const response = await harness.mf.dispatchFetch(
			`http://localhost/api/v1/${path}`,
			{
				method,
				headers:
				{
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		return {
			status: response.status,
			body: await readJson(response),
		};
	}

	async function probe(path: string): Promise<unknown>
	{
		const response = await (await store()).fetch(`http://localhost${path}`);
		return response.json();
	}

	/** Poll the import until its newest run is no longer running. */
	async function importFinished(): Promise<Record<string, unknown>>
	{
		for (let i = 0; i < 30_000 / POLL_MS; i++)
		{
			const {body} = await send("workflowy-import", "GET");
			const run: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "run") : undefined;
			if (typeof run === "object" && run !== null && Reflect.get(run, "status") !== "running")
			{
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be an object above
				return run as Record<string, unknown>;
			}
			await sleep(POLL_MS);
		}
		throw new Error("the import did not finish");
	}

	async function parkedObjects(): Promise<string[]>
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its bucket with undici classes
		const bucket = (await harness.mf.getR2Bucket("SNAPSHOTS")) as unknown as R2Bucket;
		const listed = await bucket.list(
			{
				prefix: "imports/",
			},
		);
		return listed.objects.map((object) => object.key);
	}

	it("refuses to import before the account connects", async () =>
	{
		expect(
			{
				status: await send("workflowy-import", "GET"),
				start: await send("workflowy-import", "POST"),
				tutorialNodes: ((await probe("/__nodes")) as unknown[]).length > 0,
			},
		).toStrictEqual(
			{
				status:
				{
					status: 200,
					body:
					{
						run: null,
					},
				},
				start:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-not-connected",
					},
				},
				tutorialNodes: true,
			},
		);
	});

	it("imports the whole tree, its relationships, completion, metadata and the account state, replacing the tutorial", async () =>
	{
		await send(
			"workflowy-connection",
			"POST",
			{
				email: "alice@example.com",
				password: PASSWORD,
			},
		);
		const tutorialNodes = ((await probe("/__nodes")) as unknown[]).length;
		upstreamCalls.length = 0;
		const started = await send("workflowy-import", "POST");
		const run = await importFinished();
		const stub = await store();
		const state = await stub.getAccountState();
		expect(
			{
				started:
				{
					status: started.status,
					phase: (
						started.body as
						{
							run:
							{
								phase: string;
							};
						}
					).run.phase,
				},
				run:
				{
					...run,
					startedAt: typeof run.startedAt,
					finishedAt: typeof run.finishedAt,
				},
				upstreamCalls,
				nodes: await probe("/__nodes"),
				treeLog: await probe("/__tree-log"),
				numberedStarts: await probe("/__internal-metadata"),
				account:
				{
					account: state.rows.account.map(({userId, dateJoinedSec}) => (
					{
						userId,
						dateJoinedSec,
					})),
					stars: state.rows.stars,
					starOrder: state.rows.starOrder,
					tagColors: state.rows.tagColors,
					savedViews: state.rows.savedViews,
					theme: state.rows.accountSettings.map((row) => row.theme),
					expandedKeys: state.expandedKeys,
				},
				parked: await parkedObjects(),
				connection: (await send("workflowy-connection", "GET")).body,
			},
		).toStrictEqual(
			{
				started:
				{
					status: 202,
					phase: "fetching",
				},
				run:
				{
					phase: "idle",
					status: "ok",
					message: null,
					startedAt: "number",
					finishedAt: "number",
					applied: 7,
					found:
					{
						nodes: 7,
						completed: 1,
						mirrors: 1,
						backlinks: 1,
						expandedKeys: 2,
						stars: 2,
						starOrder: 2,
						tagColors: 1,
						savedViews: 1,
						settings: 2,
					},
					nodes:
					{
						added: 7,
						updated: 0,
						unchanged: 0,
						phasedOut: tutorialNodes,
						metadataWritten: 1,
					},
					failures:
					{
						invalidNodes: 0,
						metadataSkipped: 0,
					},
					// Every row the run read and wrote, index rows included, from the start request to the finish.
					rowsRead: 3758,
					rowsWritten: 494,
				},
				// One account read and one tree read over the stored session; no login, so the password is never needed.
				upstreamCalls: ["/get_initialization_data", "/get_tree_data/"],
				// Only the imported tree is live: the tutorial is gone, with no confirm.
				nodes: [
					{
						id: PROJECTS,
						parentId: null,
						name: "Projects",
						completedAt: null,
					},
					{
						id: DONE,
						parentId: PROJECTS,
						name: "Finished task",
						completedAt: JOINED + 31,
					},
					{
						id: ORIGINAL,
						parentId: null,
						name: "Mirrored bullet",
						completedAt: null,
					},
					{
						id: MIRROR,
						parentId: PROJECTS,
						name: "Mirrored bullet",
						completedAt: null,
					},
					{
						id: TARGET,
						parentId: null,
						name: "Linked from Projects",
						completedAt: null,
					},
					{
						id: REFERENCES,
						parentId: TARGET,
						name: "",
						completedAt: null,
					},
					{
						id: BACKLINK,
						parentId: REFERENCES,
						name: "Projects",
						completedAt: null,
					},
				],
				treeLog:
				{
					txId: "701",
					mirrors: [
						{
							mirror_id: MIRROR,
							original_id: ORIGINAL,
						},
						{
							mirror_id: BACKLINK,
							original_id: PROJECTS,
						},
					],
				},
				numberedStarts: [
					{
						node_id: ORIGINAL,
						numbered_start: 3,
					},
				],
				account:
				{
					account: [
						{
							userId: "123",
							dateJoinedSec: JOINED,
						},
					],
					stars: [
						{
							locationKey: PROJECTS.slice(-12),
							treeRoot: "None",
						},
						{
							locationKey: TARGET.slice(-12),
							treeRoot: "None",
						},
					],
					starOrder: [
						{
							position: 0,
							entry: PROJECTS.slice(-12),
						},
						{
							position: 1,
							entry: TARGET.slice(-12),
						},
					],
					tagColors: [
						{
							tag: "#work",
							colorIndex: 3,
						},
					],
					savedViews: [
						{
							position: 0,
							projectId: PROJECTS.slice(-12),
							auxiliaryRootProjectId: null,
							searchQuery: "#work",
						},
					],
					theme: ["dark"],
					expandedKeys: EXPANDED,
				},
				// The fetched tree waits in R2 only while the import runs.
				parked: [],
				connection:
				{
					connected: true,
					status: "connected",
					email: "alice@example.com",
					mirror: false,
				},
			},
		);
	}, 60_000);

	it("marks the connection expired when workflowy.com refuses the stored session, keeping the outline", async () =>
	{
		const before = await probe("/__nodes");
		sessionsExpired = true;
		upstreamCalls.length = 0;
		await send("workflowy-import", "POST");
		const run = await importFinished();
		expect(
			{
				run:
				{
					status: run.status,
					message: run.message,
					phase: run.phase,
				},
				upstreamCalls,
				connection: (await send("workflowy-connection", "GET")).body,
				restart: await send("workflowy-import", "POST"),
				outlineKept: await probe("/__nodes"),
				cookie: await (await store()).openedWorkflowySession(),
			},
		).toStrictEqual(
			{
				run:
				{
					status: "expired",
					message: "workflowy-session-expired",
					phase: "idle",
				},
				upstreamCalls: ["/get_initialization_data"],
				connection:
				{
					connected: true,
					status: "expired",
					email: "alice@example.com",
					mirror: false,
				},
				restart:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-session-expired",
					},
				},
				outlineKept: before,
				cookie: null,
			},
		);
	}, 60_000);
});
