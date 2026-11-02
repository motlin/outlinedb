import {z} from "zod";
import {inIds, notAMirror, PathBuilder} from "@outlinedb/shared/cache";
import {and, eq} from "drizzle-orm";
import {nodeContent} from "@outlinedb/shared/db";
import type {AppDatabase} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {stripHtmlTags} from "@outlinedb/shared/html";
import type {EmbeddingNeighbour} from "../embedding-index.js";
import {defineOp, fail, ok} from "./define.js";

type RelatedType = "similar" | "parent-candidates" | "link-targets";

const RelatedNodeSchema = z.strictObject(
	{
		id: z.string(),
		name: z.string().nullable(),
		note: z.string().nullable(),
		distance: z.number(),
		path: z.array(z.string()),
	},
);

export const RelatedResponseSchema = z.strictObject(
	{
		results: z.array(RelatedNodeSchema),
	},
);

type RelatedNode = z.output<typeof RelatedNodeSchema>;

/** Fill each node's ancestor path in one batched PathBuilder query. */
function fillPaths(database: AppDatabase, nodes: RelatedNode[]): void
{
	const parts = new PathBuilder(database).buildFullPathPartsBatch(nodes.map((n) => n.id));
	for (const node of nodes)
	{
		node.path = parts.get(node.id) ?? [];
	}
}

/** The most neighbours one query asks for: Vectorize's `topK` ceiling. */
const MAX_NEIGHBOURS = 100;

interface Candidate extends RelatedNode
{
	parentId: string | null;
}

/** The neighbours that are current, non-mirror nodes other than the source and inside the threshold, nearest first. */
function loadCandidates(
	database: AppDatabase,
	neighbours: EmbeddingNeighbour[],
	sourceNodeId: string,
	threshold: number,
): Candidate[]
{
	const near = neighbours.filter((n) => n.id !== sourceNodeId && n.distance < threshold);
	if (near.length === 0)
	{
		return [];
	}
	const rows = database
		.select(
			{
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
				parentId: nodeContent.parentId,
			},
		)
		.from(nodeContent)
		.where(
			and(
				inIds(
					nodeContent.id,
					near.map((n) => n.id),
				),
				eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				notAMirror(nodeContent.id),
			),
		)
		.all();
	const byId = new Map(rows.map((row) => [row.id, row]));
	return near.flatMap((n) =>
	{
		const row = byId.get(n.id);
		return row === undefined
			? []
			: [
					{
						...row,
						distance: n.distance,
						path: [],
					},
				];
	});
}

/** The source node and its ancestors up to Home. */
function ancestorIds(database: AppDatabase, sourceNodeId: string): Set<string>
{
	const ancestors = new Set<string>();
	let currentId: string | null = sourceNodeId;
	while (currentId !== null && !ancestors.has(currentId))
	{
		ancestors.add(currentId);
		const node = database
			.select(
				{
					parentId: nodeContent.parentId,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, currentId), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get();
		currentId = node?.parentId ?? null;
	}
	return ancestors;
}

/** Which of `ids` have at least one current child. */
function withChildren(database: AppDatabase, ids: string[]): Set<string>
{
	const rows = database
		.selectDistinct(
			{
				parentId: nodeContent.parentId,
			},
		)
		.from(nodeContent)
		.where(and(inIds(nodeContent.parentId, ids), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
		.all();
	return new Set(rows.flatMap((row) => (row.parentId === null ? [] : [row.parentId])));
}

/**
 * Narrow the candidates by type: `similar` keeps them all, `parent-candidates` keeps containers outside the source's
 * ancestry, and `link-targets` keeps nodes with a visible name.
 */
function narrow(database: AppDatabase, type: RelatedType, candidates: Candidate[], sourceNodeId: string): Candidate[]
{
	if (type === "parent-candidates")
	{
		const ancestors = ancestorIds(database, sourceNodeId);
		const containers = withChildren(
			database,
			candidates.map((c) => c.id),
		);
		return candidates.filter((c) => !ancestors.has(c.id) && containers.has(c.id));
	}
	if (type === "link-targets")
	{
		return candidates.filter((c) => (c.name ? stripHtmlTags(c.name) : "").length > 0);
	}
	return candidates;
}

/** Finds related nodes using semantic similarity; the required fields are validated here so each 400 names what is missing. */
export const relatedFind = defineOp(
	{
		input: z.object(
			{
				nodeId: z.string().optional(),
				type: z.string().optional(),
				limit: z.number().optional(),
				threshold: z.number().optional(),
				model: z.string().optional(),
			},
		),
		output: RelatedResponseSchema,
		async run(ctx, {nodeId, type, limit = 10, threshold = 0.5, model = "minilm"})
		{
			if (!nodeId)
			{
				return fail(
					400,
					{
						error: "nodeId is required",
					},
				);
			}

			if (!type)
			{
				return fail(
					400,
					{
						error: "type is required",
					},
				);
			}

			const validTypes: RelatedType[] = ["similar", "parent-candidates", "link-targets"];
			const relatedType = validTypes.find((valid) => valid === type);
			if (!relatedType)
			{
				return fail(
					400,
					{
						error: `type must be one of: ${validTypes.join(", ")}`,
					},
				);
			}

			// Without an index (no vector store bound) there is nothing to rank: the empty result clients already handle.
			const {db: database, config} = ctx;
			const index = config.features.embeddings ? ctx.embeddingIndex?.(model) : undefined;
			if (!index)
			{
				return ok(
					{
						results: [],
					},
				);
			}

			const vector = await index.vectorFor(nodeId);
			if (!vector)
			{
				return fail(
					404,
					{
						error: "Node embedding not found. Ensure embeddings have been generated.",
					},
				);
			}

			// Fetch extra neighbours: the source, mirrors and the type's filter drop some of them.
			const neighbours = await index.query(vector, Math.min(MAX_NEIGHBOURS, limit * 3 + 1));
			const candidates = loadCandidates(database, neighbours, nodeId, threshold);
			const results: RelatedNode[] = narrow(database, relatedType, candidates, nodeId)
				.slice(0, limit)
				.map(({parentId: _parentId, ...node}) => node);
			fillPaths(database, results);
			return ok(
				{
					results,
				},
			);
		},
	},
);
