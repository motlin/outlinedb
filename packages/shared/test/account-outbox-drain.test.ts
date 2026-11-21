import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {AccountOutboxRecorder, readPendingAccountOutbox, withPendingAccountState} from "../src/cache/account-outbox.js";
import {readAccountSnapshot, writeAccountSnapshot} from "../src/cache/account-store.js";
import type {AccountSnapshot} from "../src/cache/account-store.js";
import {applyExpansionDelta, readExpansion, replaceExpansion} from "../src/cache/expansion-store.js";
import {LocalAccount} from "../src/cache/local-account.js";
import {runUnitOfWork} from "../src/cache/node-composite.js";
import {outboxStatus} from "../src/cache/outbox.js";
import * as schema from "../src/db/schema.js";
import {drainAccountOutbox} from "../src/internal/account-outbox-drain.js";
import type {AccountOutboxPusher} from "../src/internal/account-outbox-drain.js";
import {OutboxNotAcknowledged} from "../src/internal/errors.js";
import type {InternalOp} from "../src/internal/push-and-poll.js";
import {systemTimeAt} from "../src/temporal/constants.js";
import {migratedMemoryDatabase} from "./helpers/migrated-memory-database.js";

/** The account's join date: 2026-01-01T00:00:00Z. */
const JOINED_SEC = 1_767_225_600;
/** The drain's client timestamp: 60 days after the join date. */
const CT = 60 * 86_400;
const DRAIN = new Date("2026-03-02T00:00:00.000Z");

function snapshot(rootMetadata: Record<string, unknown>, settings: Record<string, unknown> = {}): AccountSnapshot
{
	return {
		account:
		{
			userId: "42",
			dateJoinedSec: JOINED_SEC,
		},
		rootMetadata,
		settings,
		visibleFeatures: [],
	};
}

/** Advance the fake clock one second, so each unit of work has its own system time. */
function tick(): void
{
	vi.setSystemTime(Date.now() + 1000);
}

/**
 * A mirror whose account tables hold `rootMetadata` and `settings` and whose expansion store holds `expanded`, with a
 * LocalAccount that records account outbox rows.
 */
function setup(rootMetadata: Record<string, unknown>, settings: Record<string, unknown> = {}, expanded: string[] = [])
{
	const database = drizzle(
		migratedMemoryDatabase(),
		{
			schema,
		},
	);
	runUnitOfWork(database, (unitOfWork) =>
	{
		writeAccountSnapshot(unitOfWork, snapshot(rootMetadata, settings));
		replaceExpansion(unitOfWork, expanded, 0);
	});
	tick();
	const recorder = new AccountOutboxRecorder();
	const account = new LocalAccount(
		database,
		{
			outbox: recorder,
		},
	);
	const expand = (delta: Record<string, boolean>) =>
	{
		runUnitOfWork(database, (unitOfWork) =>
		{
			applyExpansionDelta(unitOfWork, delta);
			recorder.record(
				unitOfWork,
				Object.keys(delta).map((key) => (
				{
					subject: "expansion",
					key,
				})),
			);
		});
	};
	const pending = () =>
		readPendingAccountOutbox(database).map(({subject, key, lastError}) => (
		{
			subject,
			key: key.replaceAll("\u001F", "."),
			lastError,
		}));

	const pushes: InternalOp[][] = [];
	const settingPosts: [string, string][] = [];
	const expansionPushes: Record<string, boolean>[] = [];
	const featurePosts: [string, boolean][] = [];
	/** A fake workflowy.com whose root metadata is `upstream`; `fail` makes every request reject with it. */
	const pusher = (upstream: Record<string, unknown>, fail?: Error, echo = true): AccountOutboxPusher => (
	{
		session: async () =>
			Promise.resolve(
				{
					userId: 42,
					dateJoinedSec: JOINED_SEC,
				},
			),
		rootMetadata: async () => (fail === undefined ? Promise.resolve(upstream) : Promise.reject(fail)),
		push: async (ops, accept) =>
		{
			pushes.push(ops);
			runUnitOfWork(database, (unitOfWork) =>
			{
				accept(
					unitOfWork,
					{
						txId: "2",
						serverRun: echo ? ops : [],
						remote: [],
						needsRefresh: false,
					},
				);
			});
			return Promise.resolve();
		},
		changeSetting: async (name, value) =>
		{
			settingPosts.push([name, value]);
			return fail === undefined ? Promise.resolve() : Promise.reject(fail);
		},
		pushExpansions: async (delta) =>
		{
			expansionPushes.push(delta);
			return Promise.resolve();
		},
		setFeature: async (codename, on) =>
		{
			featurePosts.push([codename, on]);
			return fail === undefined ? Promise.resolve() : Promise.reject(fail);
		},
	});
	const drain = async (target: AccountOutboxPusher) =>
	{
		vi.setSystemTime(DRAIN);
		return drainAccountOutbox(database, target);
	};
	return {
		database,
		account,
		expand,
		pending,
		pushes,
		settingPosts,
		expansionPushes,
		featurePosts,
		pusher,
		drain,
	};
}

describe("drainAccountOutbox", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: new Date("2026-03-01T00:00:00.000Z"),
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("sends root paths as one root edit against upstream's metadata, each setting, the saved-views delta and the expansion delta, then closes every row", async () =>
	{
		const {account, expand, pending, pushes, settingPosts, expansionPushes, pusher, drain} = setup(
			{
				dateFormat: "MMM D",
			},
			{
				saved_views_json: "[]",
			},
			["aaaaaaaa"],
		);
		account.change(
			[
				{
					path: ["color", "tags", "#home"],
					value: 7,
				},
				{
					path: ["dateFormat"],
					value: undefined,
				},
			],
			[
				["show_completed", true],
				["theme", "dark"],
			],
		);
		tick();
		await account.setSavedViews(
			JSON.stringify([
				{
					zoomedProject:
					{
						projectid: "p1",
						auxiliaryRootProjectId: "None",
					},
					searchQuery: "",
				},
			]),
			"",
		);
		tick();
		expand(
			{
				aaaaaaaa: false,
				bbbbbbbb: true,
			},
		);
		const pendingBefore = pending();

		const result = await drain(
			pusher(
				{
					dateFormat: "MMM D",
					color:
					{
						tags:
						{
							"#work": 6,
						},
					},
				},
			),
		);

		expect(
			{
				pendingBefore,
				result,
				pushes,
				settingPosts,
				expansionPushes,
				pendingAfter: pending(),
			},
		).toStrictEqual(
			{
				pendingBefore: [
					{
						subject: "root_metadata",
						key: "color.tags.#home",
						lastError: null,
					},
					{
						subject: "root_metadata",
						key: "dateFormat",
						lastError: null,
					},
					{
						subject: "setting",
						key: "show_completed",
						lastError: null,
					},
					{
						subject: "setting",
						key: "theme",
						lastError: null,
					},
					{
						subject: "saved_view",
						key: "p1",
						lastError: null,
					},
					{
						subject: "expansion",
						key: "aaaaaaaa",
						lastError: null,
					},
					{
						subject: "expansion",
						key: "bbbbbbbb",
						lastError: null,
					},
				],
				result:
				{
					ops: 5,
					closed: 7,
				},
				pushes: [
					[
						{
							type: "edit",
							data:
							{
								projectid: "None",
								metadataPatches: [
									{
										op: "remove",
										path: ["dateFormat"],
									},
									{
										op: "add",
										path: ["color", "tags", "#home"],
										value: 7,
									},
								],
								metadataInversePatches: [
									{
										op: "remove",
										path: ["color", "tags", "#home"],
									},
									{
										op: "add",
										path: ["dateFormat"],
										value: "MMM D",
									},
								],
							},
							client_timestamp: CT,
							undo_data:
							{
								previous_last_modified: null,
								previous_last_modified_by: null,
								metadataPatches: [
									{
										op: "remove",
										path: ["color", "tags", "#home"],
									},
									{
										op: "add",
										path: ["dateFormat"],
										value: "MMM D",
									},
								],
							},
						},
					],
				],
				settingPosts: [
					[
						"saved_views_json_delta",
						JSON.stringify(
							{
								added: [
									{
										zoomedProject:
										{
											projectid: "p1",
											auxiliaryRootProjectId: "None",
										},
										searchQuery: "",
									},
								],
							},
						),
					],
					["show_completed", "yes"],
					["theme", "dark"],
				],
				expansionPushes: [
					{
						aaaaaaaa: false,
						bbbbbbbb: true,
					},
				],
				pendingAfter: [],
			},
		);
	});

	it("sends each pending feature flag as one enable or disable call with its local value, then closes its row", async () =>
	{
		const {account, pending, featurePosts, pusher, drain} = setup(
			{},
			{
				features:
				{
					dates: true,
				},
			},
		);
		account.setFeature("dashboards", true);
		tick();
		account.setFeature("dates", false);
		tick();
		account.setFeature("dashboards", false);
		const pendingBefore = pending();

		const result = await drain(pusher({}));

		expect(
			{
				pendingBefore,
				result,
				featurePosts,
				pendingAfter: pending(),
			},
		).toStrictEqual(
			{
				pendingBefore: [
					{
						subject: "feature",
						key: "dashboards",
						lastError: null,
					},
					{
						subject: "feature",
						key: "dates",
						lastError: null,
					},
				],
				result:
				{
					ops: 2,
					closed: 2,
				},
				featurePosts: [
					["dashboards", false],
					["dates", false],
				],
				pendingAfter: [],
			},
		);
	});

	it("records a failed request as last_error on its rows, keeps them pending, surfaces it in the status, and throws", async () =>
	{
		const {database, account, pending, pushes, pusher, drain} = setup({});
		account.change(
			[
				{
					path: ["dateFormat"],
					value: "YYYY",
				},
			],
			[],
		);

		await expect(drain(pusher({}, new Error("workflowy.com is unreachable")))).rejects.toThrow(
			"workflowy.com is unreachable",
		);
		// The same failure again leaves the row as it is: a repeat writes no new version.
		vi.setSystemTime(new Date("2026-03-02T00:01:00.000Z"));
		await expect(
			drainAccountOutbox(database, pusher({}, new Error("workflowy.com is unreachable"))),
		).rejects.toThrow("workflowy.com is unreachable");

		expect(
			{
				pushes,
				pending: pending(),
				versions: database.select().from(schema.accountOutbox).all().length,
				status: outboxStatus(database),
			},
		).toStrictEqual(
			{
				pushes: [],
				versions: 2,
				pending: [
					{
						subject: "root_metadata",
						key: "dateFormat",
						lastError: "workflowy.com is unreachable",
					},
				],
				status:
				{
					pending: 1,
					oldestEnqueuedAt: systemTimeAt("2026-03-01 00:00:01.000"),
					lastError: "workflowy.com is unreachable",
				},
			},
		);
	});

	it("keeps the root rows pending when the server run does not echo the edit", async () =>
	{
		const {account, pending, pusher, drain} = setup({});
		account.change(
			[
				{
					path: ["dateFormat"],
					value: "YYYY",
				},
			],
			[],
		);

		await expect(drain(pusher({}, undefined, false))).rejects.toBeInstanceOf(OutboxNotAcknowledged);

		expect(pending().map(({key, lastError}) => [key, lastError !== null])).toStrictEqual([["dateFormat", true]]);
	});

	it("closes a root row without pushing when upstream already holds its value", async () =>
	{
		const {account, pending, pushes, pusher, drain} = setup({});
		account.change(
			[
				{
					path: ["dateFormat"],
					value: "YYYY",
				},
			],
			[],
		);

		const result = await drain(
			pusher(
				{
					dateFormat: "YYYY",
				},
			),
		);

		expect(
			{
				result,
				pushes,
				pending: pending(),
			},
		).toStrictEqual(
			{
				result:
				{
					ops: 0,
					closed: 1,
				},
				pushes: [],
				pending: [],
			},
		);
	});
});

describe("refreshes keep pending account state", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: new Date("2026-03-01T00:00:00.000Z"),
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("a fresh upstream snapshot keeps each pending root path and setting at its local value", () =>
	{
		const {database, account} = setup(
			{
				dateFormat: "MMM D",
				timeFormat: "h:mm a",
			},
			{
				theme: "light",
				font: "system",
			},
		);
		account.change(
			[
				{
					path: ["dateFormat"],
					value: "YYYY",
				},
			],
			[["theme", "dark"]],
		);
		tick();

		const merged = withPendingAccountState(
			database,
			snapshot(
				{
					dateFormat: "D MMM",
					timeFormat: "HH:mm",
				},
				{
					theme: "system",
					font: "etBook",
				},
			),
		);

		expect(
			{
				rootMetadata: merged.rootMetadata,
				settings: merged.settings,
			},
		).toStrictEqual(
			{
				rootMetadata:
				{
					dateFormat: "YYYY",
					timeFormat: "HH:mm",
				},
				settings:
				{
					theme: "dark",
					font: "etBook",
				},
			},
		);
	});

	it("a fresh upstream snapshot keeps each pending feature flag at its local value", () =>
	{
		const {database, account} = setup(
			{},
			{
				features:
				{
					dates: true,
				},
			},
		);
		account.setFeature("dashboards", true);
		tick();

		const merged = withPendingAccountState(
			database,
			snapshot(
				{},
				{
					features:
					{
						dates: "yes",
						table: true,
					},
				},
			),
		);

		expect(merged.settings).toStrictEqual(
			{
				features:
				{
					dates: true,
					table: true,
					dashboards: true,
				},
			},
		);
	});

	it("an expansion re-seed keeps each pending key's local state", () =>
	{
		const {database, expand} = setup({}, {}, ["aaaaaaaa", "cccccccc"]);
		expand(
			{
				aaaaaaaa: false,
				bbbbbbbb: true,
			},
		);
		tick();

		runUnitOfWork(database, (unitOfWork) =>
		{
			replaceExpansion(unitOfWork, ["aaaaaaaa", "dddddddd"], 0);
		});

		expect(
			{
				keys: [...(readExpansion(database) ?? [])].toSorted(),
				stored: readAccountSnapshot(database)?.rootMetadata,
			},
		).toStrictEqual(
			{
				keys: ["bbbbbbbb", "dddddddd"],
				stored: {},
			},
		);
	});
});
