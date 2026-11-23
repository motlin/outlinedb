import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import type {ProbeStore} from "./probe-entry";
import {POLL_MS, pollResult, sleep, uuid} from "./sync-upstream";

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
const PHOTO = uuid(8);
const SCAN = uuid(9);
const DELETED_FILE = uuid(10);
/** The photo's bytes on workflowy.com's S3, behind the signed URL the session mints. */
const PHOTO_BYTES = "photo bytes from S3";
const SCAN_BYTES = "scanned page";
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
	{
		id: PHOTO,
		nm: "",
		prnt: PROJECTS,
		pr: 2,
		ct: 17,
		metadata:
		{
			s3File:
			{
				isFile: true,
				fileName: "photo.jpg",
				fileType: "image/jpeg",
				objectFolder: "folder-a",
			},
		},
	},
	{
		id: SCAN,
		nm: "",
		prnt: PROJECTS,
		pr: 3,
		ct: 18,
		metadata:
		{
			s3File:
			{
				isFile: true,
				fileName: "scan.pdf",
				fileType: "application/pdf",
				objectFolder: "folder-b",
			},
		},
	},
	{
		id: DELETED_FILE,
		nm: "",
		prnt: PROJECTS,
		pr: 4,
		ct: 19,
		metadata:
		{
			s3File:
			{
				isFile: true,
				fileName: "gone.png",
				fileType: "image/png",
				isDeleted: true,
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
	/** Cleared to make S3 refuse the scan's bytes, as it does for a file it no longer holds. */
	let scanAvailable = false;
	const upstreamCalls: string[] = [];
	/** Each `/push_and_poll` the account sent: the transaction id it started from and the op types it pushed. */
	const pushes:
	{
		from: string;
		ops: string[];
	}[] = [];
	/** The tree's newest transaction id on the fake workflowy.com; each push and poll moves it on by one. */
	let upstreamTxId = 701;
	/** Set to answer every `/push_and_poll` with need_refreshed_project_tree, as once the log drops the stored id. */
	let refreshNeeded = false;
	/**
	 * Set to apply pushed ops but leave them out of the reply's server run, as workflowy.com does for an op whose effect
	 * already held; the nodes those pushes created then show up in `/get_tree_data/`.
	 */
	let serverRunDropped = false;
	/** The nodes pushes with {@link serverRunDropped} created, as `/get_tree_data/` items. */
	const unechoedItems:
	{
		id: string;
		nm: string;
		prnt: string | null;
	}[] = [];

	/** Answer one `/push_and_poll` form as workflowy.com does, echoing pushed ops back as the server's run of them. */
	function pushAndPoll(body: string): Response
	{
		const data: unknown = JSON.parse(new URLSearchParams(body).get("push_poll_data") ?? "[]");
		const tree: unknown = Array.isArray(data) ? data[0] : undefined;
		const from =
			typeof tree === "object" && tree !== null ? Reflect.get(tree, "most_recent_operation_transaction_id") : "";
		const operations: unknown =
			typeof tree === "object" && tree !== null ? Reflect.get(tree, "operations") : undefined;
		const ops = Array.isArray(operations) ? operations : [];
		pushes.push(
			{
				from: String(from),
				ops: ops.map((op: unknown) =>
					String(typeof op === "object" && op !== null ? Reflect.get(op, "type") : ""),
				),
			},
		);
		upstreamTxId++;
		const txId = String(upstreamTxId);
		if (serverRunDropped)
		{
			for (const op of ops)
			{
				const opData: unknown = typeof op === "object" && op !== null ? Reflect.get(op, "data") : undefined;
				const raw: unknown = Reflect.get(Object(opData), "project_trees");
				const trees: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
				const parent = String(Reflect.get(Object(opData), "parentid"));
				for (const created of Array.isArray(trees) ? trees : [])
				{
					unechoedItems.push(
						{
							id: String(Reflect.get(Object(created), "id")),
							nm: String(Reflect.get(Object(created), "nm")),
							prnt: parent === "None" ? null : parent,
						},
					);
				}
			}
			return pollResult(
				txId,
				{
					server_run_operation_transaction_json: JSON.stringify(
						{
							id: txId,
							ops: [],
						},
					),
				},
			);
		}
		return pollResult(
			txId,
			ops.length === 0
				? {}
				:
					{
						server_run_operation_transaction_json: JSON.stringify(
							{
								id: txId,
								ops,
							},
						),
					},
		);
	}

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
				// One attachment per alarm run, so copying the files resumes across alarm runs too.
				IMPORT_FILES_PER_TICK: "1",
			},
			{
				outboundService: async (request: Request): Promise<Response> =>
				{
					const url = new URL(request.url);
					upstreamCalls.push(url.host === "s3.test" ? `s3:${url.pathname}` : url.pathname);
					if (url.host === "s3.test")
					{
						if (url.pathname === `/${PHOTO}`)
						{
							return new Response(PHOTO_BYTES);
						}
						return scanAvailable && url.pathname === `/${SCAN}`
							? new Response(SCAN_BYTES)
							: new Response(
									"denied",
									{
										status: 403,
										statusText: "Forbidden",
									},
								);
					}
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
					if (url.pathname === "/push_and_poll" && refreshNeeded)
					{
						return pollResult(
							String(upstreamTxId),
							{
								need_refreshed_project_tree: true,
							},
						);
					}
					if (url.pathname === "/push_and_poll")
					{
						return pushAndPoll(await request.text());
					}
					const signed = /^\/file-proxy\/signed-original\/123\/([^/]+)\/$/u.exec(url.pathname);
					if (signed !== null)
					{
						return Response.json(
							{
								url: `http://s3.test/${signed[1] ?? ""}`,
							},
						);
					}
					if (url.pathname === "/get_tree_data/")
					{
						return Response.json(
							{
								items: [...TREE_ITEMS, ...unechoedItems],
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
			body: typedSyncTime(await readJson(response)),
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
		const photo = await harness.mf.dispatchFetch(`http://localhost/api/v1/files/${PHOTO}/original`);
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
				photo:
				{
					status: photo.status,
					type: photo.headers.get("content-type"),
					body: await photo.text(),
				},
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
					applied: 10,
					found:
					{
						nodes: 10,
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
						added: 10,
						updated: 0,
						unchanged: 0,
						phasedOut: tutorialNodes,
						metadataWritten: 4,
					},
					failures:
					{
						invalidNodes: 0,
						metadataSkipped: 0,
					},
					// The live attachments' bytes, copied into R2 one alarm run each; the deleted one is left behind.
					files:
					{
						found: 2,
						copied: 1,
						alreadyCopied: 0,
						failed: 1,
						bytes: PHOTO_BYTES.length,
						failures: [
							{
								nodeId: SCAN,
								fileName: "scan.pdf",
								error: "HTTP 403 Forbidden",
							},
						],
					},
					// Every row the run read and wrote, index rows included, from the start request to the finish.
					rowsRead: 3880,
					rowsWritten: 551,
				},
				// One account read and one tree read over the stored session, then a signed URL and a download per live
				// attachment; no login, so the password is never needed.
				upstreamCalls: [
					"/get_initialization_data",
					"/get_tree_data/",
					`/file-proxy/signed-original/123/${PHOTO}/`,
					`s3:/${PHOTO}`,
					`/file-proxy/signed-original/123/${SCAN}/`,
					`s3:/${SCAN}`,
				],
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
					{
						id: PHOTO,
						parentId: PROJECTS,
						name: "",
						completedAt: null,
					},
					{
						id: SCAN,
						parentId: PROJECTS,
						name: "",
						completedAt: null,
					},
					{
						id: DELETED_FILE,
						parentId: PROJECTS,
						name: "",
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
					lastSyncAt: "number",
				},
				// The node points at our copy, so its bytes come from R2.
				photo:
				{
					status: 200,
					type: "image/jpeg",
					body: PHOTO_BYTES,
				},
			},
		);
	}, 60_000);

	it("re-imports without copying an attachment again, and copies the one that failed before", async () =>
	{
		scanAvailable = true;
		upstreamCalls.length = 0;
		await send("workflowy-import", "POST");
		const run = await importFinished();
		const scan = await harness.mf.dispatchFetch(`http://localhost/api/v1/files/${SCAN}/original`);
		expect(
			{
				status: run.status,
				files: run.files,
				upstreamCalls,
				scan:
				{
					status: scan.status,
					body: await scan.text(),
				},
			},
		).toStrictEqual(
			{
				status: "ok",
				files:
				{
					found: 2,
					copied: 1,
					alreadyCopied: 1,
					failed: 0,
					bytes: SCAN_BYTES.length,
					failures: [],
				},
				upstreamCalls: [
					"/get_initialization_data",
					"/get_tree_data/",
					`/file-proxy/signed-original/123/${SCAN}/`,
					`s3:/${SCAN}`,
				],
				scan:
				{
					status: 200,
					body: SCAN_BYTES,
				},
			},
		);
	}, 60_000);

	/** Poll until `done` holds. */
	async function until(done: () => boolean | Promise<boolean>): Promise<void>
	{
		for (let i = 0; i < 30_000 / POLL_MS; i++)
		{
			if (await done())
			{
				return;
			}
			await sleep(POLL_MS);
		}
		throw new Error("timed out waiting");
	}

	async function alarmDue(job: "outbox" | "sync"): Promise<unknown>
	{
		return Reflect.get((await probe(`/__alarm-due?job=${job}`)) as object, "due");
	}

	async function outbox(): Promise<
	{
		pending: number;
		lastError: string | null;
	}>
	{
		const {pending, lastError} = (await (await store()).syncStatus()).outbox;
		return {
			pending,
			lastError,
		};
	}

	async function connectionStatus(): Promise<unknown>
	{
		return Reflect.get((await send("workflowy-connection", "GET")).body as object, "status");
	}

	it("keeps syncing once turned on: catches up from the imported transaction id and delivers writes over the stored session", async () =>
	{
		pushes.length = 0;
		upstreamCalls.length = 0;
		const turnedOn = await send(
			"workflowy-connection",
			"PATCH",
			{
				mirror: true,
			},
		);
		await until(() => pushes.length > 0);
		const created = await send(
			"nodes",
			"POST",
			{
				parent_id: "None",
				name: "Written while mirroring",
			},
		);
		await until(async () => pushes.length > 1 && (await outbox()).pending === 0);
		expect(
			{
				turnedOn,
				created: created.status,
				pushes,
				upstreamCalls,
				outbox: await outbox(),
				txId: Reflect.get((await probe("/__tree-log")) as object, "txId"),
				// Every request rode the cookie the connect stored; nothing logged in again.
				logins,
				syncScheduled: typeof (await alarmDue("sync")),
			},
		).toStrictEqual(
			{
				turnedOn:
				{
					status: 200,
					body:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: true,
						lastSyncAt: "number",
					},
				},
				created: 201,
				// The catch-up polls from the transaction id the import seeded, and the write's push follows it.
				pushes: [
					{
						from: "701",
						ops: [],
					},
					{
						from: "702",
						ops: ["bulk_create"],
					},
				],
				upstreamCalls: ["/get_initialization_data", "/push_and_poll", "/push_and_poll"],
				outbox:
				{
					pending: 0,
					lastError: null,
				},
				txId: "703",
				logins: 1,
				syncScheduled: "number",
			},
		);

		// A push whose reply leaves the create out of its server run: the drain reads workflowy.com back over the same
		// stored session, finds the node there, and closes the row.
		upstreamCalls.length = 0;
		serverRunDropped = true;
		const unechoed = await send(
			"nodes",
			"POST",
			{
				parent_id: "None",
				name: "Pushed but left out of the server run",
			},
		);
		await until(
			async () => pushes.length > 2 && ((await outbox()).pending === 0 || (await outbox()).lastError !== null),
		);
		serverRunDropped = false;
		expect(
			{
				created: unechoed.status,
				upstreamCalls,
				outbox: await outbox(),
				unechoedItems: unechoedItems.map(({nm, prnt}) => [nm, prnt]),
				logins,
			},
		).toStrictEqual(
			{
				created: 201,
				upstreamCalls: ["/push_and_poll", "/get_tree_data/"],
				outbox:
				{
					pending: 0,
					lastError: null,
				},
				unechoedItems: [["Pushed but left out of the server run", null]],
				logins: 1,
			},
		);
	}, 60_000);

	it("stops syncing and tells the user to import again once the transaction log no longer holds the stored id", async () =>
	{
		const before = await send("sync-status", "GET");
		refreshNeeded = true;
		const due = await (await store()).fetch("http://localhost/__sync-due-now");
		await until(
			async () => Reflect.get((await send("sync-status", "GET")).body as object, "phase") === "needs_seed",
		);
		const stopped =
		{
			syncStatus: await send("sync-status", "GET"),
			syncDue: await alarmDue("sync"),
		};
		refreshNeeded = false;
		// Turning keep-syncing off and on again restarts the catch-up, which clears the stop.
		await send(
			"workflowy-connection",
			"PATCH",
			{
				mirror: false,
			},
		);
		await send(
			"workflowy-connection",
			"PATCH",
			{
				mirror: true,
			},
		);
		await until(async () => Reflect.get((await send("sync-status", "GET")).body as object, "phase") === "idle");
		expect(
			{
				before,
				due: due.status,
				stopped,
				restarted: typeof (await alarmDue("sync")),
			},
		).toStrictEqual(
			{
				before:
				{
					status: 200,
					body:
					{
						phase: "idle",
						applied: 0,
					},
				},
				due: 204,
				stopped:
				{
					syncStatus:
					{
						status: 200,
						body:
						{
							phase: "needs_seed",
							applied: 0,
							error: "Workflowy answered need_refreshed_project_tree: the cache's transaction id 704 is no longer in the tree's log; run './bin/run.js cache import-api' to reseed it. Import again from Settings > Workflowy to resume syncing.",
						},
					},
					syncDue: null,
				},
				restarted: "number",
			},
		);
	}, 60_000);

	it("pauses syncing when workflowy.com refuses the session, keeps writes queued, and resumes once signed in again", async () =>
	{
		sessionsExpired = true;
		pushes.length = 0;
		upstreamCalls.length = 0;
		const due = await (await store()).fetch("http://localhost/__sync-due-now");
		await until(async () => (await connectionStatus()) === "expired");
		const queued = await send(
			"nodes",
			"POST",
			{
				parent_id: "None",
				name: "Written while paused",
			},
		);
		// The write arms the outbox job; its alarm clears it without a drain, since sync is paused.
		await until(async () => (await alarmDue("outbox")) === null);
		const paused =
		{
			due: due.status,
			queued: queued.status,
			connection: (await send("workflowy-connection", "GET")).body,
			upstreamCalls: [...upstreamCalls],
			outbox: await outbox(),
			syncDue: await alarmDue("sync"),
			logins,
		};
		sessionsExpired = false;
		pushes.length = 0;
		upstreamCalls.length = 0;
		const signedIn = await send(
			"workflowy-connection",
			"POST",
			{
				email: "alice@example.com",
				password: PASSWORD,
			},
		);
		await until(async () => pushes.length > 1 && (await outbox()).pending === 0);
		const resumed =
		{
			signedIn: signedIn.body,
			pushes: [...pushes],
			outbox: await outbox(),
			syncScheduled: typeof (await alarmDue("sync")),
		};
		const turnedOff = await send(
			"workflowy-connection",
			"PATCH",
			{
				mirror: false,
			},
		);
		expect(
			{
				paused,
				resumed,
				off:
				{
					connection: turnedOff.body,
					syncDue: await alarmDue("sync"),
					outboxDue: await alarmDue("outbox"),
				},
			},
		).toStrictEqual(
			{
				paused:
				{
					due: 204,
					queued: 201,
					connection:
					{
						connected: true,
						status: "expired",
						email: "alice@example.com",
						mirror: true,
						lastSyncAt: "number",
					},
					// One refused catch-up, and no password to log in again with.
					upstreamCalls: ["/push_and_poll"],
					outbox:
					{
						pending: 2,
						lastError: null,
					},
					syncDue: null,
					logins: 1,
				},
				resumed:
				{
					signedIn:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: true,
						lastSyncAt: "number",
					},
					// The queued write drains first, then the catch-up polls on from its transaction.
					pushes: [
						{
							from: "705",
							ops: ["bulk_create"],
						},
						{
							from: "706",
							ops: [],
						},
					],
					outbox:
					{
						pending: 0,
						lastError: null,
					},
					syncScheduled: "number",
				},
				off:
				{
					connection:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: false,
						lastSyncAt: "number",
					},
					syncDue: null,
					outboxDue: null,
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
					lastSyncAt: "number",
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

/** A connection body with its `lastSyncAt` timestamp replaced by its type, so expectations stay exact. */
function typedSyncTime(body: unknown): unknown
{
	if (typeof body !== "object" || body === null || typeof Reflect.get(body, "lastSyncAt") !== "number")
	{
		return body;
	}
	return {
		...body,
		lastSyncAt: "number",
	};
}
