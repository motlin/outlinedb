import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as sqliteVec from "sqlite-vec";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import {mirrors, nodeContent, nodeEmbeddings} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {MemoryEmbeddingIndex, SqliteVecIndex} from "../src/server/embedding-index.js";
import type {EmbeddingIndex} from "../src/server/embedding-index.js";
import {nodeTreeHost} from "../src/server/node-host.js";
import {Ops} from "../src/server/ops/index.js";
import {bindTreeHost} from "../src/server/tree-snapshot.js";
import type {ServerContext} from "../src/server/context.js";

// From the registry, which the web setup wraps to check each op output against its schema.
const relatedFind = Ops["related.find"];

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const open: DatabaseConstructor.Database[] = [];
afterEach(() =>
{
	for (const sqlite of open.splice(0))
	{
		sqlite.close();
	}
});

/**
 * Home > Garden (Tomatoes, Basil), Home > Kitchen (Recipes > Pesto), a mirror of Garden, and an unnamed container.
 * Vectors put Garden's neighbours in the order Recipes, Kitchen, Basil, Unnamed, Mirror, Far; Basil's start Kitchen,
 * Unnamed, Recipes.
 */
function memoryDb()
{
	const sqlite = new DatabaseConstructor(":memory:");
	sqliteVec.load(sqlite);
	open.push(sqlite);
	const db = drizzle(
		sqlite,
		{
			schema,
		},
	);
	bindTreeHost(db, nodeTreeHost(sqlite));
	migrate(
		db,
		{
			migrationsFolder,
		},
	);
	const node = (id: string, name: string | null, parentId: string | null, note: string | null = null) => (
	{
		id,
		name,
		note,
		parentId,
		systemFrom: SEEDED_AT,
		systemTo: FAR_FUTURE_DATE,
	});
	db.insert(nodeContent)
		.values([
			node("garden", "Garden", null),
			node("tomatoes", "Tomatoes", "garden"),
			node("basil", "Basil", "garden", "Sweet"),
			node("kitchen", "Kitchen", null),
			node("recipes", "Recipes", "kitchen"),
			node("pesto", "Pesto", "recipes"),
			node("unnamed", "<b></b>", null),
			node("unnamed-child", "x", "unnamed"),
			node("mir", "Garden", null),
			node("far", "Far away", null),
		])
		.run();
	db.insert(mirrors)
		.values(
			{
				originalId: "garden",
				mirrorId: "mir",
				systemFrom: SEEDED_AT,
				systemTo: FAR_FUTURE_DATE,
			},
		)
		.run();
	return db;
}

const VECTORS: [string, number[]][] = [
	["garden", [1, 0]],
	["recipes", [0.99, 0.141]],
	["kitchen", [0.98, 0.199]],
	["basil", [0.95, 0.312]],
	["unnamed", [0.9, 0.436]],
	["mir", [0.85, 0.527]],
	["far", [0, 1]],
];

function contextWith(db: ServerContext["db"], index: EmbeddingIndex | undefined, embeddings = true): ServerContext
{
	return {
		db,
		config:
		{
			features:
			{
				embeddings,
				treeSnapshot: true,
			},
		},
		embeddingIndex: index && (() => index),
	} as unknown as ServerContext;
}

async function related(ctx: ServerContext, input: Record<string, unknown>)
{
	return relatedFind.run(ctx, relatedFind.input.parse(input));
}

const round = (value: number) => Math.round(value * 1000) / 1000;

async function relatedIds(ctx: ServerContext, input: Record<string, unknown>)
{
	const result = await related(ctx, input);
	if (!result.ok)
	{
		throw new Error(JSON.stringify(result.body));
	}
	return result.value.results.map((node) => (
	{
		id: node.id,
		path: node.path,
		distance: round(node.distance),
	}));
}

describe("relatedFind over an embedding index", () =>
{
	it("ranks similar nodes by distance, skipping the source, mirrors and anything past the threshold", async () =>
	{
		const index = new MemoryEmbeddingIndex();
		index.upsert(
			VECTORS.map(([id, vector]) => (
			{
				id,
				vector,
			})),
		);
		const ctx = contextWith(memoryDb(), index);
		await expect(
			relatedIds(
				ctx,
				{
					nodeId: "garden",
					type: "similar",
					threshold: 0.2,
				},
			),
		).resolves.toStrictEqual([
			{
				id: "recipes",
				path: ["Kitchen", "Recipes"],
				distance: 0.01,
			},
			{
				id: "kitchen",
				path: ["Kitchen"],
				distance: 0.02,
			},
			{
				id: "basil",
				path: ["Garden", "Basil"],
				distance: 0.05,
			},
			{
				id: "unnamed",
				path: [],
				distance: 0.1,
			},
		]);
	});

	it("keeps only containers outside the source's ancestry as parent candidates", async () =>
	{
		const index = new MemoryEmbeddingIndex();
		index.upsert(
			VECTORS.map(([id, vector]) => (
			{
				id,
				vector,
			})),
		);
		const ctx = contextWith(memoryDb(), index);
		await expect(
			relatedIds(
				ctx,
				{
					nodeId: "basil",
					type: "parent-candidates",
					threshold: 0.9,
				},
			),
		).resolves.toStrictEqual([
			{
				id: "kitchen",
				path: ["Kitchen"],
				distance: 0.007,
			},
			{
				id: "unnamed",
				path: [],
				distance: 0.009,
			},
			{
				id: "recipes",
				path: ["Kitchen", "Recipes"],
				distance: 0.015,
			},
		]);
	});

	it("keeps only named nodes as link targets", async () =>
	{
		const index = new MemoryEmbeddingIndex();
		index.upsert(
			VECTORS.map(([id, vector]) => (
			{
				id,
				vector,
			})),
		);
		const ctx = contextWith(memoryDb(), index);
		await expect(
			relatedIds(
				ctx,
				{
					nodeId: "basil",
					type: "link-targets",
					limit: 3,
					threshold: 0.9,
				},
			),
		).resolves.toStrictEqual([
			{
				id: "kitchen",
				path: ["Kitchen"],
				distance: 0.007,
			},
			{
				id: "recipes",
				path: ["Kitchen", "Recipes"],
				distance: 0.015,
			},
			{
				id: "garden",
				path: ["Garden"],
				distance: 0.05,
			},
		]);
	});

	it("answers 404 when the source node has no vector", async () =>
	{
		const ctx = contextWith(memoryDb(), new MemoryEmbeddingIndex());
		await expect(
			related(
				ctx,
				{
					nodeId: "garden",
					type: "similar",
				},
			),
		).resolves.toStrictEqual(
			{
				ok: false,
				status: 404,
				body:
				{
					error: "Node embedding not found. Ensure embeddings have been generated.",
				},
			},
		);
	});

	it("answers an empty list when the host has no index", async () =>
	{
		await expect(
			related(
				contextWith(memoryDb(), undefined),
				{
					nodeId: "garden",
					type: "similar",
				},
			),
		).resolves.toStrictEqual(
			{
				ok: true,
				value:
				{
					results: [],
				},
			},
		);
	});
});

describe("SqliteVecIndex", () =>
{
	function embeddingRow(nodeId: string, model: string, vector: number[])
	{
		return {
			nodeId,
			model,
			embedding: Buffer.from(new Float32Array(vector).buffer),
			systemFrom: SEEDED_AT,
			systemTo: FAR_FUTURE_DATE,
		};
	}

	it("reads a node's stored vector and ranks the model's current rows by cosine distance", () =>
	{
		const db = memoryDb();
		db.insert(nodeEmbeddings)
			.values([
				embeddingRow("garden", "minilm", [1, 0]),
				embeddingRow("kitchen", "minilm", [0, 1]),
				embeddingRow("basil", "minilm", [1, 1]),
				embeddingRow("far", "mpnet", [1, 0]),
			])
			.run();
		const index = new SqliteVecIndex(db, "minilm");
		expect(index.vectorFor("garden")).toStrictEqual([1, 0]);
		expect(index.vectorFor("far")).toBeUndefined();
		const neighbours = index.query([1, 0], 2);
		expect(
			neighbours.map(({id, distance}) => (
			{
				id,
				distance: round(distance),
			})),
		).toStrictEqual([
			{
				id: "garden",
				distance: 0,
			},
			{
				id: "basil",
				distance: 0.293,
			},
		]);
	});

	it("versions upserts and deletes instead of overwriting rows", () =>
	{
		const db = memoryDb();
		const index = new SqliteVecIndex(db, "minilm");
		index.upsert([
			{
				id: "garden",
				vector: [1, 0],
			},
		]);
		index.upsert([
			{
				id: "garden",
				vector: [0, 1],
			},
		]);
		expect(index.vectorFor("garden")).toStrictEqual([0, 1]);
		index.delete(["garden"]);
		expect(index.vectorFor("garden")).toBeUndefined();
		expect(
			db
				.select(
					{
						nodeId: nodeEmbeddings.nodeId,
					},
				)
				.from(nodeEmbeddings)
				.all(),
		).toHaveLength(2);
	});
});
