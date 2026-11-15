/* oxlint-disable typescript/no-unsafe-type-assertion -- a partial context and adapter fake: the routes under test use only these */
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {vi} from "vite-plus/test";
import
{
	CacheService,
	readAccountSnapshot,
	readPendingAccountOutbox,
	runUnitOfWork,
	writeAccountSnapshot,
} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../../src/server/context.js";

const migrationsFolder = join(import.meta.dirname, "../../../shared/src/db/migrations");

/** An account write that pushed to workflowy.com first, which is down. */
async function unreachable(): Promise<never>
{
	return Promise.reject(new Error("workflowy.com is unreachable"));
}

/** A fresh migrated in-memory database. */
function memoryDatabase()
{
	const db = drizzle(
		new DatabaseConstructor(":memory:"),
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
	return db;
}

/**
 * A mirror context whose account tables hold `rootMetadata` and `settings`, with an internal adapter whose account
 * writes fail as if workflowy.com were down: every account write must land locally with account outbox rows.
 * `extraAdapter` adds or overrides adapter methods.
 */
export function mirrorAccountContext(
	rootMetadata: Record<string, unknown>,
	settings: Record<string, unknown> = {},
	extraAdapter: Record<string, unknown> = {},
)
{
	const db = memoryDatabase();
	runUnitOfWork(db, (unitOfWork) =>
	{
		writeAccountSnapshot(
			unitOfWork,
			{
				account:
				{
					userId: "42",
					dateJoinedSec: 1_500_000_000,
				},
				rootMetadata,
				settings,
				visibleFeatures: [],
			},
		);
	});
	const adapter =
	{
		loadAccountState: vi.fn<WorkflowyInternalAdapter["loadAccountState"]>(async () => Promise.resolve()),
		setRootMeta: vi.fn<WorkflowyInternalAdapter["setRootMeta"]>(unreachable),
		setRootMetaValues: vi.fn<WorkflowyInternalAdapter["setRootMetaValues"]>(unreachable),
		setSetting: vi.fn<WorkflowyInternalAdapter["setSetting"]>(unreachable),
		setSavedViews: vi.fn<WorkflowyInternalAdapter["setSavedViews"]>(unreachable),
		setExpanded: vi.fn<WorkflowyInternalAdapter["setExpanded"]>(unreachable),
		setRawExpansionKeys: vi.fn<WorkflowyInternalAdapter["setRawExpansionKeys"]>(unreachable),
		...extraAdapter,
	};
	const outboxWritten = vi.fn<() => void>();
	const ctx =
	{
		db,
		cacheService: new CacheService(db),
		outboxWritten,
		internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	const pending = (subject: string) => readPendingAccountOutbox(db).filter((row) => row.subject === subject);
	/** What the account outbox would deliver: the pending rows and the local values they name. */
	const local =
	{
		/** Each pending root metadata path and its local value. */
		pendingRoot: () =>
			pending("root_metadata").map(({key}) =>
			{
				const path = key.split("\u001F");
				return {
					path,
					value: path.reduce<unknown>(
						(value, segment) =>
							typeof value === "object" && value !== null ? Reflect.get(value, segment) : undefined,
						readAccountSnapshot(db)?.rootMetadata,
					),
				};
			}),
		/** The pending expansion keys. */
		pendingExpansion: () => pending("expansion").map(({key}) => key),
		rootMeta: () => readAccountSnapshot(db)?.rootMetadata,
	};
	return {
		db,
		ctx,
		adapter,
		outboxWritten,
		local,
	};
}
