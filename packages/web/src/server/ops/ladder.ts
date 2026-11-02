/**
 * The asap ladder ops: read both ladders, drop a row into another tier, complete a
 * row. Every write publishes on the context's event bus, which the host fans out to its sockets.
 *
 * Everything worth testing lives in {@link LadderService}, and the ops are built by
 * {@link createLadderOps} so a test can drive them against a fake service with no database and no API key.
 */

import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {NodeTreeReader, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {NodeTree} from "@outlinedb/shared/cache";
import {z} from "zod";
import type {ServerContext} from "../context.js";
import {LadderService} from "../ladder-service.js";
import type {LadderBuckets} from "../ladder-service.js";
import {LadderEventSchema} from "../ladder-events.js";
import type {RawNode} from "../ladder-model.js";
import {defineOp, fail, ok, toJson} from "./define.js";

/** Where each ladder lives. Both buckets sit four levels down, under their root. */
const BUCKET_PATHS: Record<string, string[]> =
{
	work: ["Work", "☑️ Next (Work)", "✅ Tasks", "📌 Tasks (asap) (work)"],
	personal: ["Personal", "☑️ Next (Personal)", "✅ Tasks", "📌 Tasks (asap) (personal)"],
};

/** The part of {@link LadderService} the ops call. */
export type LadderOperations = Pick<LadderService, "read" | "move" | "complete">;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A required, non-empty string field. */
const Required = z.string().min(1);
const MoveInput = z.object(
	{
		root: Required,
		node_id: Required,
		to_tier: Required,
		before_id: z.string().optional(),
	},
);
const CompleteInput = z.object(
	{
		root: Required,
		node_id: Required,
	},
);

const LadderItemSchema = z.strictObject(
	{
		id: z.string(),
		name: z.string(),
		/** Incomplete children, recursively, as read from the cache. */
		get children(): z.ZodArray<typeof LadderItemSchema>
		{
			return z.array(LadderItemSchema);
		},
		hasChildren: z.boolean().optional(),
		/** How many incomplete nodes sit under this one, at any depth. */
		descendantCount: z.number(),
	},
);

const LadderSchema = z.strictObject(
	{
		root: z.string(),
		bucketId: z.string(),
		tiers: z.array(
			z.strictObject(
				{
					tier: z.number(),
					label: z.string(),
					id: z.string(),
					capacity: z.number(),
					state: z.enum(["room", "exact", "over"]),
					items: z.array(LadderItemSchema),
				},
			),
		),
	},
);

/** Both ladders, keyed by root. */
export const LaddersResponseSchema = z.strictObject(
	{
		ladders: z.record(z.string(), LadderSchema),
	},
);

/** A refused move or complete; `reconcile` asks the page to reread the ladder instead of failing outright. */
export const LadderFailureSchema = z.strictObject(
	{
		error: z.string(),
		reconcile: z.literal(true).optional(),
	},
);

/** The write a move or complete made, as the event bus announced it. */
export const LadderEventEnvelopeSchema = z.strictObject(
	{
		event: z.strictObject(LadderEventSchema.shape),
	},
);

/** Build the three ladder ops over a service factory; a test injects a fake service. */
export function createLadderOps(createService: (ctx: ServerContext) => LadderOperations)
{
	return {
		"ladder.read": defineOp(
			{
				input: z.object({}),
				output: LaddersResponseSchema,
				async run(ctx)
				{
					return ok(
						toJson(
							{
								ladders: await createService(ctx).read(),
							},
						),
					);
				},
			},
		),
		"ladder.move": defineOp(
			{
				input: MoveInput,
				output: LadderEventEnvelopeSchema,
				async run(ctx, {root, node_id: nodeId, to_tier: toTier, before_id: beforeNodeId})
				{
					try
					{
						const event = await createService(ctx).move(
							{
								root,
								nodeId,
								toTier,
								...(beforeNodeId === undefined
									? {}
									:
										{
											beforeNodeId,
										}),
							},
						);
						return ok(
							{
								event,
							},
						);
					}
					catch (error)
					{
						return fail(
							400,
							{
								error: messageOf(error),
								reconcile: true,
							} satisfies z.output<typeof LadderFailureSchema>,
						);
					}
				},
			},
		),
		"ladder.complete": defineOp(
			{
				input: CompleteInput,
				output: LadderEventEnvelopeSchema,
				async run(ctx, {root, node_id: nodeId})
				{
					try
					{
						return ok(
							{
								event: await createService(ctx).complete(
									{
										root,
										nodeId,
									},
								),
							},
						);
					}
					catch (error)
					{
						return fail(
							400,
							{
								error: messageOf(error),
							} satisfies z.output<typeof LadderFailureSchema>,
						);
					}
				},
			},
		),
	};
}

function toRawNode(tree: NodeTree): RawNode
{
	return {
		id: tree.id,
		name: tree.name,
		completedAt: tree.completedAt?.toISOString() ?? null,
		children: tree.children?.map(toRawNode),
	};
}

/**
 * Build the real service: read the buckets out of the cache, write through the
 * Workflowy API, and announce every write on the process-wide bus.
 */
function defaultService(ctx: ServerContext): LadderService
{
	const adapter = ctx.apiKey ? ctx.internalAdapter?.() : undefined;
	return new LadderService(
		{
			readBuckets: async () =>
			{
				const reader = new NodeTreeReader(ctx.cacheService);
				const buckets: LadderBuckets = {};
				for (const [root, path] of Object.entries(BUCKET_PATHS))
				{
					const bucket = ctx.cacheService.findNodeByPath(path);
					if (!bucket)
					{
						throw new Error(`no ${root} asap bucket at ${path.join(" > ")}`);
					}
					const [tree] = await reader.readNodes(
						[bucket.id],
						{
							depth: 3,
						},
					);
					if (tree === undefined)
					{
						throw new Error(`could not read the ${root} asap bucket`);
					}
					buckets[root] = toRawNode(tree);
				}
				return buckets;
			},
			moveNode: async (nodeId, parentId, position) => writeClient(ctx).moveNode(nodeId, parentId, position),
			// With the internal API a landing is one exact-index move; without it, the service rotates the suffix.
			...(adapter &&
			{
				moveTo: async (nodeId, parentId, index) =>
					adapter.moveTo(
						{
							ids: [nodeId],
							parentId,
							index,
						},
					),
			}),
			// Reordering can renumber siblings, so refresh their cached priorities too.
			refreshTier: async (parentId) =>
			{
				const children = await apiClient(ctx).getChildNodes(parentId);
				for (const child of children)
				{
					ctx.cacheService.insertNode(child, parentId);
				}
			},
			completeNode: async (nodeId) => writeClient(ctx).completeNode(nodeId),
			events: ctx.ladderEvents,
		},
	);
}

function apiClient(ctx: ServerContext): WorkflowyApiClient
{
	if (!ctx.apiKey)
	{
		throw new Error("WORKFLOWY_API_KEY environment variable is required");
	}
	return new WorkflowyApiClient(ctx.apiKey, undefined, ctx.config.apiUrl);
}

function writeClient(ctx: ServerContext): WorkflowyWriteThroughClient
{
	return new WorkflowyWriteThroughClient(apiClient(ctx), ctx.cacheService);
}

export const ladderOps = createLadderOps(defaultService);
