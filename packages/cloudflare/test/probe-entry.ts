import {CacheService} from "@workflowy/shared/cache";
import * as dbSchema from "@workflowy/shared/db";
import {drizzle} from "drizzle-orm/durable-sqlite";
import type {OpInput, OpName, OpOutput, OpResult} from "@workflowy/web/server-app";
import {UserStore} from "../src/user-store";
import worker from "../src/worker";

/** Test-only subclass exposing the DO's raw SQLite state. */
export class ProbeStore extends UserStore {
	private calls = 0;

	/** Counts every op so tests can assert the one-call-per-request rule. */
	override async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>> {
		this.calls++;
		return super.call(op, input);
	}

	override fetch(request: Request): Response {
		const url = new URL(request.url);
		if (url.pathname === "/__probe") {
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
			return Response.json({names, schema, migrations, appliedOnBoot: this.appliedOnBoot});
		}
		if (url.pathname === "/__calls") {
			const calls = this.calls;
			if (url.searchParams.has("reset")) {
				this.calls = 0;
			}
			return Response.json({calls});
		}
		if (url.pathname === "/__session") {
			const write = url.searchParams.get("write");
			if (write !== null) {
				this.sessionStore.write(write);
			}
			return Response.json({cookie: this.sessionStore.read() ?? null});
		}
		if (url.pathname === "/__publish") {
			this.ladderEvents.publish({
				verb: "move",
				nodeId: "node-1",
				name: "Write the report",
				fromTier: "3",
				toTier: "1",
				at: "2026-10-27T00:00:00.000Z",
			});
			return Response.json({ok: true});
		}
		if (url.pathname === "/__system-froms") {
			return Response.json(
				this.ctx.storage.sql
					.exec(
						"SELECT system_from, count(*) AS n FROM node_content GROUP BY system_from ORDER BY system_from",
					)
					.toArray()
					.map((row) => row.n),
			);
		}
		if (url.pathname === "/__sync-tables") {
			const sql = this.ctx.storage.sql;
			const live = "CASE WHEN system_to = '9999-12-31 23:59:59' THEN 1 ELSE 0 END";
			return Response.json({
				runs: sql
					.exec(`SELECT phase, applied, status, ${live} AS live FROM sync_runs ORDER BY system_from, run_id`)
					.toArray(),
				runSystemFroms: Number(sql.exec("SELECT count(DISTINCT system_from) AS n FROM sync_runs").one().n),
				seen: sql
					.exec(`SELECT ${live} AS live, count(*) AS n FROM sync_seen GROUP BY live ORDER BY live`)
					.toArray(),
				seedRequests: sql.exec(`SELECT ${live} AS live FROM sync_seed_requests ORDER BY system_from`).toArray(),
			});
		}
		if (url.pathname === "/__live-ids") {
			const ids = this.ctx.storage.sql
				.exec("SELECT id FROM node_content WHERE system_to = '9999-12-31 23:59:59'")
				.toArray()
				.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
			return Response.json(ids);
		}
		if (url.pathname === "/__internal-metadata") {
			return Response.json(
				this.ctx.storage.sql
					.exec(
						"SELECT node_id, numbered_start FROM node_display_metadata WHERE system_to = '9999-12-31 23:59:59' ORDER BY node_id",
					)
					.toArray(),
			);
		}
		if (url.pathname === "/__tree-log") {
			const txId = this.ctx.storage.sql
				.exec(
					"SELECT transaction_id FROM tree_transactions WHERE tree_id = 'main' AND system_to = '9999-12-31 23:59:59'",
				)
				.toArray()
				.map((row) => row.transaction_id);
			const mirrors = this.ctx.storage.sql
				.exec(
					"SELECT mirror_id, original_id FROM mirrors WHERE system_to = '9999-12-31 23:59:59' ORDER BY mirror_id",
				)
				.toArray();
			return Response.json({txId: txId[0] ?? null, mirrors});
		}
		if (url.pathname === "/__account") {
			return Response.json(
				this.ctx.storage.sql
					.exec("SELECT user_id, date_joined_sec FROM account WHERE system_to = '9999-12-31 23:59:59'")
					.toArray(),
			);
		}
		if (url.pathname === "/__seed") {
			new CacheService(drizzle(this.ctx.storage, {schema: dbSchema})).insertNode(
				{
					id: "seed-node",
					name: url.searchParams.get("name") ?? "seeded",
					note: null,
					parent_id: null,
					priority: 100,
					createdAt: 1,
					modifiedAt: 1,
				},
				null,
			);
			return Response.json({ok: true});
		}
		return super.fetch(request);
	}
}

export default worker;
