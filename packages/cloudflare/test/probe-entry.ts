import {AsyncLocalStorage} from "node:async_hooks";
import {CacheService} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import * as dbSchema from "@outlinedb/shared/db";
import {drizzle} from "drizzle-orm/durable-sqlite";
import type {OpInput, OpName, OpOutput, OpResult} from "@outlinedb/web/server-app";
import {AlarmSchedule} from "../src/alarm-schedule";
import type {RowCounts} from "../src/row-meter";
import type {SyncStatus} from "../src/sync";
import {UserStore} from "../src/user-store";
import type {AccountSync, AdminStatus, ProvisionInput, ProvisionResult} from "../src/user-store";
import worker from "../src/worker";

type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

/**
 * How the statements of the async context in progress are metered: "unmetered" bypasses the object's row meter (the
 * tests' own reads, such as status polls, are no cost of what they measure), and an array collects each cursor so a
 * measured call counts only its own rows, however other work interleaves with it.
 */
const metering = new AsyncLocalStorage<"unmetered" | Cursor[]>();

/** Test-only subclass exposing the DO's raw SQLite state. */
export class ProbeStore extends UserStore
{
	private calls = 0;

	constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof UserStore>[1])
	{
		super(ctx, env);
		const {sql} = ctx.storage;
		const metered = sql.exec.bind(sql);
		// The prototype's exec, which the row meter shadows with its own property.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the prototype is SqlStorage's
		const unmetered = (Object.getPrototypeOf(sql) as SqlStorage).exec.bind(sql);
		Object.defineProperty(
			sql,
			"exec",
			{
				value: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) =>
				{
					const scope = metering.getStore();
					if (scope === "unmetered")
					{
						return unmetered<T>(query, ...bindings);
					}
					const cursor = metered<T>(query, ...bindings);
					scope?.push(cursor);
					return cursor;
				},
				configurable: true,
			},
		);
	}

	override async syncStatus(): Promise<SyncStatus>
	{
		return metering.run("unmetered", async () => super.syncStatus());
	}

	override async accountSync(): Promise<AccountSync>
	{
		return metering.run("unmetered", async () => super.accountSync());
	}

	override async adminStatus(): Promise<AdminStatus>
	{
		return metering.run("unmetered", async () => super.adminStatus());
	}

	/** Drain the outbox as the alarm does, counting only the rows the drain read and wrote, and why it failed. */
	// fallow-ignore-next-line unused-class-member -- tests invoke it over RPC
	async measuredDrain(): Promise<
		RowCounts &
		{
			error: string | null;
		}
	>
	{
		const cursors: Cursor[] = [];
		const error = await metering.run(cursors, async () =>
		{
			try
			{
				await this.drainOutbox?.();
				return null;
			}
			catch (thrown)
			{
				return thrown instanceof Error ? thrown.message : String(thrown);
			}
		});
		return {
			rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
			rowsWritten: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
			error,
		};
	}

	/** Counts every op so tests can assert the one-call-per-request rule. */
	override async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>>
	{
		this.calls++;
		return super.call(op, input);
	}

	/** Counts every `provision` RPC, kept in storage so the count survives a restart. */
	override provision(input: ProvisionInput): ProvisionResult
	{
		this.ctx.storage.kv.put("__provisions", String(Number(this.ctx.storage.kv.get("__provisions") ?? 0) + 1));
		return super.provision(input);
	}

	override fetch(request: Request): Response
	{
		const url = new URL(request.url);
		if (url.pathname === "/__rows")
		{
			return Response.json(this.rowMeter.rows());
		}
		return metering.run("unmetered", () => this.probe(request, url));
	}

	private probe(request: Request, url: URL): Response
	{
		if (url.pathname === "/__alarm-due")
		{
			const job = url.searchParams.get("job");
			return Response.json(
				{
					due:
						job === "outbox" || job === "sync" || job === "embeddings"
							? new AlarmSchedule(this.ctx.storage).due(job)
							: null,
				},
			);
		}
		if (url.pathname === "/__provisions")
		{
			return Response.json(
				{
					provisions: Number(this.ctx.storage.kv.get("__provisions") ?? 0),
				},
			);
		}
		if (url.pathname === "/__probe")
		{
			const names = this.ctx.storage.sql
				.exec("SELECT name FROM sqlite_master ORDER BY name")
				.toArray()
				.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
			const schema = this.ctx.storage.sql
				.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
				.toArray();
			const migrations = Number(
				this.ctx.storage.sql.exec("SELECT count(*) AS n FROM __drizzle_migrations").one().n,
			);
			return Response.json(
				{
					names,
					schema,
					migrations,
					appliedOnBoot: this.appliedOnBoot,
				},
			);
		}
		if (url.pathname === "/__sync-due-now")
		{
			// A scheduled sync's due time moves to now, as when its time arrives; the real alarm then runs it.
			const schedule = new AlarmSchedule(this.ctx.storage);
			if (schedule.due("sync") === null)
			{
				return new Response(
					"no sync is scheduled",
					{
						status: 409,
					},
				);
			}
			void schedule.set("sync", Date.now());
			return new Response(
				null,
				{
					status: 204,
				},
			);
		}
		if (url.pathname === "/__calls")
		{
			const calls = this.calls;
			if (url.searchParams.has("reset"))
			{
				this.calls = 0;
			}
			return Response.json(
				{
					calls,
				},
			);
		}
		if (url.pathname === "/__session")
		{
			const write = url.searchParams.get("write");
			if (write !== null)
			{
				this.sessionStore.write(write);
			}
			return Response.json(
				{
					cookie: this.sessionStore.read() ?? null,
				},
			);
		}
		if (url.pathname === "/__publish")
		{
			this.ladderEvents.publish(
				{
					verb: "move",
					nodeId: "node-1",
					name: "Write the report",
					fromTier: "3",
					toTier: "1",
					at: "2026-10-27T00:00:00.000Z",
				},
			);
			return Response.json(
				{
					ok: true,
				},
			);
		}
		if (url.pathname === "/__system-froms")
		{
			return Response.json(
				this.ctx.storage.sql
					.exec(
						"SELECT system_from, count(*) AS n FROM node_content GROUP BY system_from ORDER BY system_from",
					)
					.toArray()
					.map((row) => row.n),
			);
		}
		if (url.pathname === "/__sync-tables")
		{
			const sql = this.ctx.storage.sql;
			const live = `CASE WHEN system_to = ${FAR_FUTURE_DATE} THEN 1 ELSE 0 END`;
			return Response.json(
				{
					runs: sql
						.exec(
							`SELECT phase, applied, status, rows_read AS rowsRead, rows_written AS rowsWritten, ${live} AS live ` +
								"FROM sync_runs ORDER BY system_from, run_id",
						)
						.toArray(),
					runSystemFroms: Number(sql.exec("SELECT count(DISTINCT system_from) AS n FROM sync_runs").one().n),
					seedRequests: sql
						.exec(
							`SELECT ${live} AS live, CASE WHEN system_from <= system_to THEN 1 ELSE 0 END AS ordered FROM sync_seed_requests ORDER BY system_from`,
						)
						.toArray(),
				},
			);
		}
		if (url.pathname === "/__live-ids")
		{
			const ids = this.ctx.storage.sql
				.exec(`SELECT id FROM node_content WHERE system_to = ${FAR_FUTURE_DATE}`)
				.toArray()
				.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
			return Response.json(ids);
		}
		if (url.pathname === "/__internal-metadata")
		{
			return Response.json(
				this.ctx.storage.sql
					.exec(
						`SELECT node_id, numbered_start FROM node_display_metadata WHERE system_to = ${FAR_FUTURE_DATE} ORDER BY node_id`,
					)
					.toArray(),
			);
		}
		if (url.pathname === "/__files")
		{
			return Response.json(
				this.ctx.storage.sql
					.exec(
						`SELECT node_id, file_name FROM s3_files WHERE system_to = ${FAR_FUTURE_DATE} ORDER BY node_id`,
					)
					.toArray(),
			);
		}
		if (url.pathname === "/__tree-log")
		{
			const txId = this.ctx.storage.sql
				.exec(
					`SELECT transaction_id FROM tree_transactions WHERE tree_id = 'main' AND system_to = ${FAR_FUTURE_DATE}`,
				)
				.toArray()
				.map((row) => row.transaction_id);
			const mirrors = this.ctx.storage.sql
				.exec(
					`SELECT mirror_id, original_id FROM mirrors WHERE system_to = ${FAR_FUTURE_DATE} ORDER BY mirror_id`,
				)
				.toArray();
			return Response.json(
				{
					txId: txId[0] ?? null,
					mirrors,
				},
			);
		}
		if (url.pathname === "/__account")
		{
			return Response.json(
				this.ctx.storage.sql
					.exec(`SELECT user_id, date_joined_sec FROM account WHERE system_to = ${FAR_FUTURE_DATE}`)
					.toArray(),
			);
		}
		if (url.pathname === "/__seed")
		{
			const parentId = url.searchParams.get("parent");
			new CacheService(
				drizzle(
					this.ctx.storage,
					{
						schema: dbSchema,
					},
				),
			).insertNode(
				{
					id: url.searchParams.get("id") ?? "seed-node",
					name: url.searchParams.get("name") ?? "seeded",
					note: null,
					parent_id: parentId,
					priority: Number(url.searchParams.get("priority") ?? 100),
					createdAt: 1,
					modifiedAt: 1,
				},
				parentId,
			);
			return Response.json(
				{
					ok: true,
				},
			);
		}
		return super.fetch(request);
	}
}

export default worker;
