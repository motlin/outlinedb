import {AsyncLocalStorage} from "node:async_hooks";
import {CacheService} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import * as dbSchema from "@outlinedb/shared/db";
import {drizzle} from "drizzle-orm/durable-sqlite";
import type {OpInput, OpName, OpOutput, OpResult} from "@outlinedb/web/server-app";
import {AlarmSchedule} from "../src/alarm-schedule";
import {deriveCredentialsKey, openSecret} from "../src/credentials-crypto";
import type {RowCounts} from "../src/row-meter";
import type {SyncStatus} from "../src/sync";
import {UserStore} from "../src/user-store";
import type {AccountSync, AdminStatus, ProvisionInput, ProvisionResult} from "../src/user-store";
import worker from "../src/worker";
import type {WorkflowyImportView} from "../src/workflowy-import";

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

	override workflowyImportStatus(): WorkflowyImportView
	{
		return metering.run("unmetered", () => super.workflowyImportStatus());
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

	/** The live stored Workflowy session cookie, opened with this object's key; null when none is stored. */
	// fallow-ignore-next-line unused-class-member -- tests invoke it over RPC
	async openedWorkflowySession(): Promise<string | null>
	{
		const sealed = this.workflowyConnection.session();
		const secret = this.env.OUTLINEDB_CREDENTIALS_KEY;
		if (sealed === undefined || secret === undefined)
		{
			return null;
		}
		return openSecret(await deriveCredentialsKey(secret, this.ctx.id.toString()), sealed);
	}

	/**
	 * The live workflowy.com login attempt with its sealed state opened, expired or not, as JSON (an RPC object would
	 * arrive with another realm's prototype); null when none is live.
	 */
	// fallow-ignore-next-line unused-class-member -- tests invoke it over RPC
	async openedWorkflowyLoginAttempt(): Promise<string | null>
	{
		const row = this.ctx.storage.sql
			.exec(
				"SELECT attempt_id, workflowy_email, state_iv, state_ciphertext FROM workflowy_login_attempt WHERE system_to = ?",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		const secret = this.env.OUTLINEDB_CREDENTIALS_KEY;
		if (
			row === undefined ||
			secret === undefined ||
			!(row.state_iv instanceof ArrayBuffer) ||
			!(row.state_ciphertext instanceof ArrayBuffer)
		)
		{
			return null;
		}
		const opened = await openSecret(
			await deriveCredentialsKey(secret, this.ctx.id.toString()),
			{
				iv: new Uint8Array(row.state_iv),
				ciphertext: new Uint8Array(row.state_ciphertext),
			},
		);
		return JSON.stringify(
			{
				attemptId: row.attempt_id,
				email: row.workflowy_email,
				state: JSON.parse(opened) as unknown,
			},
		);
	}

	/** Move the live login attempt's expiry `ms` earlier, as if that much time had passed. */
	// fallow-ignore-next-line unused-class-member -- tests invoke it over RPC
	ageWorkflowyLoginAttempt(ms: number): void
	{
		this.ctx.storage.sql.exec(
			"UPDATE workflowy_login_attempt SET expires_at = expires_at - ? WHERE system_to = ?",
			ms,
			FAR_FUTURE_DATE,
		);
	}

	/** Every row of every table, prefixed with its table's name (each BLOB as `blob:<hex>`) and every key-value entry: all an attacker holding the database sees. */
	// fallow-ignore-next-line unused-class-member -- tests invoke it over RPC
	storageDump(): string
	{
		const {sql, kv} = this.ctx.storage;
		const tables = sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray()
			.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
		const rows = tables.flatMap((table) =>
			sql
				.exec(`SELECT * FROM "${table}"`)
				.toArray()
				.map((row) =>
					[
						table,
						...Object.values(row).map((value) =>
							value instanceof ArrayBuffer ? `blob:${Buffer.from(value).toString("hex")}` : String(value),
						),
					].join("|"),
				),
		);
		const entries = [...kv.list()].map(([key, value]) => `${key}=${String(value)}`);
		return [...rows, ...entries].join("\n");
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
		if (url.pathname === "/__nodes")
		{
			// Every live node's parent, name and completion time (Unix seconds), so an import's tree reads in one probe.
			return Response.json(
				this.ctx.storage.sql
					.exec(
						"SELECT c.id, c.parent_id AS parentId, c.name, m.completed_at AS completedAt FROM node_content c " +
							"JOIN node_metadata m ON m.node_id = c.id AND m.system_to = c.system_to " +
							`WHERE c.system_to = ${FAR_FUTURE_DATE} ORDER BY c.id`,
					)
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
