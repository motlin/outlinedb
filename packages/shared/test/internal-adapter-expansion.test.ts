import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {CacheService} from "../src/cache/cache-service.js";
import {expansionVersion, readExpansion, replaceExpansion} from "../src/cache/expansion-store.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {importInternalMetadata} from "../src/cache/internal-metadata.js";
import {storeTreeTxId} from "../src/cache/tree-transaction.js";
import * as schema from "../src/db/schema.js";
import {WorkflowyInternalAdapter} from "../src/internal/adapter.js";
import {ExpansionNotSeeded, TreeResyncRequired} from "../src/internal/errors.js";
import type {WorkflowyNode} from "../src/types/index.js";
import {createFakeInternalApi, forbidTreeData, treeDataReads} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");
const START_MS = 1_800_000_000_000;

const ALPHA = "1a2b3c4d-0000-4000-8000-000000000001";
const BRAVO = "5e6f7a8b-0000-4000-8000-000000000002";
/** Shares ALPHA's first 8 chars, so the server's key expands both, as upstream. */
const ALPHA_TWIN = "1a2b3c4d-0000-4000-8000-000000000003";
const CHARLIE = "9c9c9c9c-0000-4000-8000-000000000004";

function cachedNode(id: string): WorkflowyNode
{
	return {
		id,
		name: id,
		note: null,
		parent_id: null,
		priority: 0,
		createdAt: 0,
		modifiedAt: 0,
	};
}

function setup()
{
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	// A whole-tree import seeded the transaction-log position at the fake init's id.
	storeTreeTxId(db, "4567");
	const cacheService = new CacheService(db);
	for (const id of [ALPHA, BRAVO, ALPHA_TWIN, CHARLIE])
	{
		cacheService.insertNode(cachedNode(id), null);
	}
	const api = createFakeInternalApi();
	const clock =
	{
		ms: START_MS,
	};
	const newAdapter = () =>
		new WorkflowyInternalAdapter(
			{
				client: new WorkflowyInternalClient(
					{
						credentials:
						{
							username: "alice@example.com",
							password: "hunter2",
						},
						fetch: api.fetch,
						baseUrl: "https://workflowy.test",
						transientId: "6f1c1d1e-0000-4000-8000-000000000001",
					},
				),
				db,
				now: () => clock.ms,
				pushAndPoll:
				{
					randomId: () => "pollid01",
					timezone: "America/New_York",
					sleep: async () =>
					{
					},
				},
			},
		);
	const forbidden = forbidTreeData(api);
	/** Seed the expanded keys as a whole-tree import does. */
	const seed = (keys: string[]) =>
	{
		runUnitOfWork(db, (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, keys, clock.ms);
		});
	};
	return {
		sqlite,
		db,
		api,
		adapter: newAdapter(),
		newAdapter,
		clock,
		forbidden,
		seed,
	};
}

function network(requests: RecordedRequest[])
{
	return requests.map((r) => [r.method, r.path]);
}

function pushedTrees(request: RecordedRequest | undefined): unknown
{
	const fields = new URLSearchParams(request?.body ?? "");
	return JSON.parse(fields.get("push_poll_data") ?? "null");
}

describe("WorkflowyInternalAdapter expansion", () =>
{
	let open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open)
		{
			sqlite.close();
		}
		open = [];
		vi.restoreAllMocks();
	});
	function tracked()
	{
		const result = setup();
		open.push(result.sqlite);
		return result;
	}

	it("resolves each stored key to every cached id it prefixes, with no request", () =>
	{
		const {api, adapter, seed} = tracked();
		seed(["1a2b3c4d", "5e6f7a8b", "ffffffff"]);

		expect(adapter.getExpandedIds()).toStrictEqual([ALPHA, ALPHA_TWIN, BRAVO]);
		expect(api.requests).toStrictEqual([]);
	});

	it("tests ids against the same stored keys", () =>
	{
		const {api, adapter, seed} = tracked();
		seed(["1a2b3c4d"]);

		const isExpanded = adapter.expansionTest();

		expect(
			{
				tested: [ALPHA, ALPHA_TWIN, BRAVO, "1a2b3c4d-not-cached"].map((id) => isExpanded(id)),
				requests: api.requests,
			},
		).toStrictEqual(
			{
				tested: [true, true, false, true],
				requests: [],
			},
		);
	});

	it("reads a mirror instance's v_ key back as the virtual ids it expands, directed by the key's path", () =>
	{
		const {adapter, sqlite, seed} = tracked();
		const cache = new CacheService(
			drizzle(
				sqlite,
				{
					schema,
				},
			),
		);
		const ORIGINAL = "0a0a0a0a-0000-4000-8000-000000000010";
		const CHILD = "c0c0c0c0-0000-4000-8000-000000000011";
		const GRANDCHILD = "d1d1d1d1-0000-4000-8000-000000000012";
		const MIRROR = "bbbb0000-0000-4000-8000-000000000013";
		cache.insertNode(cachedNode(ORIGINAL), null);
		cache.insertNode(
			{
				...cachedNode(CHILD),
				parent_id: ORIGINAL,
			},
			ORIGINAL,
		);
		cache.insertNode(
			{
				...cachedNode(GRANDCHILD),
				parent_id: CHILD,
			},
			CHILD,
		);
		cache.insertNode(cachedNode(MIRROR), null);
		cache.insertMirror(ORIGINAL, MIRROR);
		seed(["v_c0c0bbbbbbbb", "v_d1d1bbbbbbbbc0c0", "v_d1d1bbbbbbbb", "5e6f7a8b"]);

		expect(adapter.getExpandedIds()).toStrictEqual([
			BRAVO,
			`virtual_${CHILD}_${MIRROR}_bbbb`,
			`virtual_${GRANDCHILD}_${MIRROR}_bbbbc0c0`,
		]);
	});

	it("answers keys of any age from the store, never reading the whole account tree", () =>
	{
		const {api, adapter, clock, forbidden, seed} = tracked();
		seed(["1a2b3c4d"]);
		clock.ms += 24 * 60 * 60 * 1000;

		const ids = adapter.getExpandedIds();
		const changes = adapter.getExpansionChanges(undefined);
		const isExpanded = adapter.expansionTest();
		const leftBar = adapter.getLeftBarExpansionKeys();

		expect(
			{
				ids,
				changes,
				alpha: isExpanded(ALPHA),
				leftBar,
				treeDataReads: treeDataReads(api),
				forbidden,
			},
		).toStrictEqual(
			{
				ids: [ALPHA, ALPHA_TWIN],
				changes:
				{
					version: expansionVersion(new Set(["1a2b3c4d"])),
					expandedIds: [ALPHA, ALPHA_TWIN],
				},
				alpha: true,
				leftBar: [],
				treeDataReads: 0,
				forbidden: [],
			},
		);
	});

	it("answers a change-feed read with no ids while the keys still match the caller's version", () =>
	{
		const {api, adapter, seed} = tracked();
		seed(["1a2b3c4d"]);
		const {version} = adapter.getExpansionChanges(undefined);

		expect(adapter.getExpansionChanges(version)).toStrictEqual(
			{
				version,
				expandedIds: null,
			},
		);
		expect(api.requests).toStrictEqual([]);
	});

	it("answers the new ids after a pushed change in the same millisecond as the caller's version", async () =>
	{
		const {adapter, seed} = tracked();
		seed(["1a2b3c4d"]);
		const {version} = adapter.getExpansionChanges(undefined);

		await adapter.setExpanded(
			{
				[CHARLIE]: true,
				[ALPHA]: false,
			},
		);

		expect(adapter.getExpansionChanges(version)).toStrictEqual(
			{
				version: expansionVersion(new Set(["9c9c9c9c"])),
				expandedIds: [CHARLIE],
			},
		);
	});

	it("answers the new ids after a change stamped earlier than the caller's version, as another process's clock may", async () =>
	{
		const {adapter, clock, seed} = tracked();
		seed(["1a2b3c4d"]);
		const {version} = adapter.getExpansionChanges(undefined);
		clock.ms -= 60_000;

		await adapter.setExpanded(
			{
				[BRAVO]: true,
			},
		);

		expect(adapter.getExpansionChanges(version)).toStrictEqual(
			{
				version: expansionVersion(new Set(["1a2b3c4d", "5e6f7a8b"])),
				expandedIds: [ALPHA, ALPHA_TWIN, BRAVO],
			},
		);
	});

	it("answers keys a whole-tree import seeded, with no request", () =>
	{
		const {api, db, adapter} = tracked();
		importInternalMetadata(
			db,
			{
				items: [],
				txId: "9999",
				expandedKeys: ["5e6f7a8b"],
			},
			START_MS,
		);

		expect(adapter.getExpandedIds()).toStrictEqual([BRAVO]);
		expect(api.requests).toStrictEqual([]);
	});

	it("fails loudly with no seeded keys, naming the reseed command, and never reads the whole account tree", () =>
	{
		const {api, adapter} = tracked();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const reads: (() => unknown)[] = [
			() => adapter.getExpandedIds(),
			() => adapter.getExpansionChanges(undefined),
			() => adapter.expansionTest(),
			() => adapter.getLeftBarExpansionKeys(),
		];
		const failures = reads.map((read) =>
		{
			let failure: unknown;
			try
			{
				read();
			}
			catch (error)
			{
				failure = error;
			}
			return failure;
		});

		expect(
			{
				failures: failures.map((error) => [
					error instanceof ExpansionNotSeeded,
					error instanceof TreeResyncRequired,
					(error as Error).message,
				]),
				logged: logged.mock.calls.length,
				requests: api.requests,
			},
		).toStrictEqual(
			{
				failures: Array.from(
					{
						length: 4,
					},
					() => [
						true,
						true,
						"The local cache has no expanded keys; run './bin/run.js cache import-api' to seed them",
					],
				),
				logged: 4,
				requests: [],
			},
		);
	});

	it("applies pushed changes to the stored keys", async () =>
	{
		const {db, adapter, seed} = tracked();
		seed(["1a2b3c4d"]);

		await adapter.setExpanded(
			{
				[CHARLIE]: true,
				[ALPHA]: false,
			},
		);

		expect(
			{
				ids: adapter.getExpandedIds(),
				stored: readExpansion(db),
			},
		).toStrictEqual(
			{
				ids: [CHARLIE],
				stored: new Set(["9c9c9c9c"]),
			},
		);
	});

	it("pushes expansion changes as project_expansions_delta keyed by the first 8 chars, with no operations", async () =>
	{
		const {api, adapter} = tracked();

		await adapter.setExpanded(
			{
				[ALPHA]: true,
				[BRAVO]: false,
			},
		);

		expect(network(api.requests)).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["POST", "/push_and_poll"],
		]);
		expect(pushedTrees(api.requests[2])).toStrictEqual([
			{
				most_recent_operation_transaction_id: "4567",
				project_expansions_delta:
				{
					"1a2b3c4d": true,
					"5e6f7a8b": false,
				},
			},
		]);
	});

	it("keys a mirror instance's expansion as v_<child4><mirror4><path>", async () =>
	{
		const {api, adapter} = tracked();

		await adapter.setExpanded(
			{
				[`virtual_${ALPHA}_${BRAVO}_9c9c`]: true,
			},
		);

		expect(pushedTrees(api.requests[2])).toStrictEqual([
			{
				most_recent_operation_transaction_id: "4567",
				project_expansions_delta:
				{
					[`v_${ALPHA.slice(0, 4)}${BRAVO.slice(0, 4)}9c9c`]: true,
				},
			},
		]);
	});

	it("keeps every pushed expansion change as a version of the delta's keys only", async () =>
	{
		const {db, adapter, seed} = tracked();
		seed(["1a2b3c4d", "9c9c9c9c"]);

		await adapter.setExpanded(
			{
				[ALPHA]: false,
				[BRAVO]: true,
			},
		);
		await adapter.setRawExpansionKeys(
			{
				"leftbar__home__None/x/__abcdefgh": true,
			},
		);
		await adapter.setExpanded(
			{
				[ALPHA]: true,
			},
		);

		const history = db
			.select(
				{
					shortKey: schema.expandedNodes.shortKey,
					systemFrom: schema.expandedNodes.systemFrom,
					systemTo: schema.expandedNodes.systemTo,
				},
			)
			.from(schema.expandedNodes)
			.orderBy(schema.expandedNodes.shortKey, schema.expandedNodes.systemFrom)
			.all();
		const live = (row: {systemTo: string}) => row.systemTo === "9999-12-31 23:59:59";
		expect(
			{
				stored: readExpansion(db),
				versions: Object.fromEntries(
					[...new Set(history.map((row) => row.shortKey))].map((key) => [
						key,
						history.filter((row) => row.shortKey === key).map(live),
					]),
				),
				untouched: new Set(history.filter((row) => row.shortKey === "9c9c9c9c").map((row) => row.systemFrom))
					.size,
			},
		).toStrictEqual(
			{
				stored: new Set(["1a2b3c4d", "5e6f7a8b", "9c9c9c9c", "leftbar__home__None/x/__abcdefgh"]),
				versions:
				{
					"1a2b3c4d": [false, true],
					"5e6f7a8b": [true],
					"9c9c9c9c": [true],
					"leftbar__home__None/x/__abcdefgh": [true],
				},
				untouched: 1,
			},
		);
	});

	it("sends nothing for no changes", async () =>
	{
		const {api, adapter} = tracked();

		await adapter.setExpanded({});

		expect(api.requests).toStrictEqual([]);
	});

	it("lists only the leftbar__ keys, unresolved", () =>
	{
		const {adapter, seed} = tracked();
		seed(["1a2b3c4d", "leftbar__home__None/x/__abcdefgh", "leftbar__starred__None/None/__None"]);

		expect(adapter.getLeftBarExpansionKeys()).toStrictEqual([
			"leftbar__home__None/x/__abcdefgh",
			"leftbar__starred__None/None/__None",
		]);
	});

	it("pushes raw expansion keys verbatim and applies them to the stored keys", async () =>
	{
		const {api, adapter, seed} = tracked();
		seed(["leftbar__home__None/x/__old00000"]);

		await adapter.setRawExpansionKeys(
			{
				"leftbar__home__None/x/__abcdefgh": true,
				"leftbar__home__None/x/__old00000": false,
			},
		);

		const push = api.requests.find((r) => r.path === "/push_and_poll");
		expect(
			{
				delta: (
					pushedTrees(push) as
					{
						project_expansions_delta: unknown;
					}[]
				)[0]?.project_expansions_delta,
				keys: adapter.getLeftBarExpansionKeys(),
			},
		).toStrictEqual(
			{
				delta:
				{
					"leftbar__home__None/x/__abcdefgh": true,
					"leftbar__home__None/x/__old00000": false,
				},
				keys: ["leftbar__home__None/x/__abcdefgh"],
			},
		);
	});
});
