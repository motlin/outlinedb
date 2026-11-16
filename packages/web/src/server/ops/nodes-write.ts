import {z} from "zod";
import {AccountNotProvisionedError, LocalAccount, LocalTreeWriter} from "@outlinedb/shared/cache";
import type {LocalRestoreInput} from "@outlinedb/shared/cache";
import {calendarParentContext} from "@outlinedb/shared/calendar-lookup";
import {adoptAfterCreate, datesInName, knownTimeZone} from "@outlinedb/shared/internal";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {hasInternalLink} from "@outlinedb/shared/workflowy";
import type {UpdateNodeResponse} from "../../node-types.js";
import {backlinksNeedSync} from "../backlinks.js";
import {withAccountState} from "../account-state.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import type {OpResult} from "./define.js";
import type {ServerContext} from "../context.js";
import
{
	CreateNodeResponseSchema,
	HomeResponseSchema,
	NoContentSchema,
	NodeEnvelopeSchema,
	UpdateNodeResponseSchema,
} from "./schemas.js";
import
{
	getNodeWriter,
	localDeletePlan,
	AfterIdSchema,
	IndexSchema,
	LegacyPositionSchema,
	ParentIdSchema,
	slotIndex,
	parseParent,
	readNodeDto,
	resolveNodeId,
	saveEffects,
} from "./nodes-shared.js";

/** A text field the handler has always passed through as sent: typed for the compiler, not checked at runtime. */
const unvalidatedText = z.custom<string>(() => true).optional();

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const WRITE_CLIENT_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";

/** A `layoutMode` as a metadata value: `"bullets"` is upstream's default, stored as no key. */
function layoutModeValue(layoutMode: string): string | undefined
{
	return layoutMode === "bullets" ? undefined : layoutMode;
}

/** A metadata write under `table`; an omitted value deletes the key. */
const TableSetSchema = z.array(
	z.object(
		{
			path: z.tuple([z.literal("table")], z.string()),
			value: z.json().optional(),
		},
	),
);

/**
 * The account's IANA timezone from the local account tables (which a mirror's account state also fills), so a create
 * never waits on a workflowy.com bootstrap; undefined (the host's) when unset or not provisioned.
 */
async function localTimeZone(ctx: ServerContext): Promise<string | undefined>
{
	try
	{
		return knownTimeZone(await new LocalAccount(ctx.db).getSetting("timezone"));
	}
	catch (error)
	{
		if (error instanceof AccountNotProvisionedError)
		{
			return undefined;
		}
		throw error;
	}
}

/**
 * Tag a dated row just created under a 📆 Calendar month as that day, as upstream's `mb1` hook does for web edits,
 * so workflowy.com uses it as the day. The tag is local metadata, which the drain delivers with the create.
 */
async function adoptUnderCalendar(
	ctx: ServerContext,
	local: LocalTreeWriter,
	created:
	{
		id: string;
		name: string;
		parentId: string | null;
	},
): Promise<void>
{
	const {id, name, parentId} = created;
	// Most creates are undated (every empty row the web app adds), so skip the calendar walk for them.
	if (parentId === null || datesInName(name).length === 0)
	{
		return;
	}
	const context = calendarParentContext(
		{
			db: ctx.db,
			cache: ctx.cacheService,
		},
		parentId,
	);
	await adoptAfterCreate(
		{
			id,
			name,
			context:
				context === undefined
					? undefined
					:
						{
							...context,
							timeZone: await localTimeZone(ctx),
						},
			adapter:
			{
				setNodeMetaValues: async (nodeId, changes) =>
				{
					local.setNodeMetaValues(nodeId, changes);
					return Promise.resolve();
				},
			},
		},
	);
}

/** The create reply for a node the cache now holds. */
async function createdNodeResult(
	ctx: ServerContext,
	id: string,
): Promise<OpResult<z.output<typeof CreateNodeResponseSchema>>>
{
	const node = await readNodeDto(ctx, id);
	if (node === undefined)
	{
		return fail(
			500,
			{
				error: `Created node ${id} is missing from the cache`,
			},
		);
	}
	return ok(
		toJson(
			{
				node,
			},
		),
		{
			created: true,
		},
	);
}

// POST /api/v1/nodes - Create node at an exact `index` among all siblings (omitted = bottom)
export const nodesCreate = defineOp(
	{
		input: z.object(
			{
				/** Omitted for Home, as an empty outline's first bullet sends it. */
				parent_id: ParentIdSchema.optional(),
				/** An empty name is valid: every empty-row create (add button, Enter) sends `name: ""`. */
				name: z.string(),
				note: unvalidatedText,
				layoutMode: unvalidatedText,
				index: IndexSchema,
				position: LegacyPositionSchema,
				/**
				 * The sibling the client saw right above the new node (null: first). While it is still a sibling it decides
				 * the slot over `index`, which counts the client's possibly stale list.
				 */
				after_id: AfterIdSchema,
				/**
				 * A client-generated lowercase UUID for the new node, so the client can edit the
				 * optimistic row before this reply.
				 */
				id: z.string().regex(CLIENT_ID_PATTERN).optional(),
			},
		),
		output: CreateNodeResponseSchema,
		async run(ctx, body)
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					500,
					{
						error: WRITE_CLIENT_REQUIRED,
					},
				);
			}
			const {name, note, layoutMode, after_id: afterId} = body;
			const parent = parseParent(ctx, body.parent_id ?? null);
			if (!parent.ok)
			{
				return fail(
					parent.status,
					{
						error: parent.error,
					},
				);
			}
			const {parentId} = parent;
			const index = slotIndex(body.index, body.position);
			if (body.id !== undefined && ctx.cacheService.getNode(body.id))
			{
				return fail(
					409,
					{
						error: `Node already exists: ${body.id}`,
					},
				);
			}

			if (parentId !== null && !ctx.cacheService.getNode(parentId))
			{
				return fail(
					404,
					{
						error: "Parent node not found",
					},
				);
			}
			const {local} = writer;
			const {id} = local.createAt(
				{
					parentId,
					...(index === undefined
						? {}
						:
							{
								index,
							}),
					...(afterId === undefined || index === undefined
						? {}
						:
							{
								afterId,
							}),
					name,
					...(body.id === undefined
						? {}
						:
							{
								id: body.id,
							}),
					...(note === undefined
						? {}
						:
							{
								note,
							}),
					...(layoutMode === undefined
						? {}
						:
							{
								layoutMode,
							}),
				},
			);
			if (hasInternalLink(`${name} ${note ?? ""}`))
			{
				local.syncBacklinks([id]);
			}
			if (writer.mode === "mirror")
			{
				await adoptUnderCalendar(
					ctx,
					local,
					{
						id,
						name,
						parentId,
					},
				);
			}
			return createdNodeResult(ctx, id);
		},
	},
);

// PATCH (or POST) /api/v1/nodes/home - Set Home's layoutMode through the root metadata
export const nodesSetHome = defineOp(
	{
		/** Upstream offers only these layouts at Home. */
		input: z.strictObject(
			{
				layoutMode: z.enum(["bullets", "board"]),
			},
		),
		output: HomeResponseSchema,
		async run(ctx, {layoutMode})
		{
			const changes = [
				{
					path: ["layoutMode"],
					value: layoutModeValue(layoutMode),
				},
			];
			if (ctx.mode === "standalone")
			{
				new LocalTreeWriter(ctx.db).setNodeMetaValues(HOME_TARGET, changes);
				return ok(
					{
						layoutMode,
					},
				);
			}
			// Home's layout is root metadata: account state, which a mirror writes locally with account outbox rows.
			return withAccountState(ctx, async (state) =>
			{
				await state.setRootMetaValues(changes);
				return ok(
					{
						layoutMode,
					},
				);
			});
		},
	},
);

// PATCH (or POST) /api/v1/nodes/:id - Update node
export const nodesUpdate = defineOp(
	{
		input: z.object(
			{
				id: z.string(),
				name: unvalidatedText,
				note: unvalidatedText,
				layoutMode: unvalidatedText,
				numberedStart: z.number().int().nullable().optional(),
				tableSet: TableSetSchema.optional(),
			},
		),
		output: UpdateNodeResponseSchema,
		async run(ctx, body)
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					500,
					{
						error: WRITE_CLIENT_REQUIRED,
					},
				);
			}

			const id = resolveNodeId(ctx, body.id);
			if (!id)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}
			const {name, note, layoutMode, numberedStart, tableSet} = body;

			// Validate that at least one field is provided
			if (
				name === undefined &&
				note === undefined &&
				layoutMode === undefined &&
				numberedStart === undefined &&
				tableSet === undefined
			)
			{
				return fail(
					400,
					{
						error: "At least one of name, note, layoutMode, numberedStart, or tableSet is required",
					},
				);
			}
			const tableChanges = (tableSet ?? []).map(({path, value}) => (
			{
				path,
				value,
			}));

			const {cacheService} = ctx;
			// Get current node to preserve parentId and verify existence
			const existingNode = cacheService.getNode(id);
			if (!existingNode)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}

			// Text lives on a mirror's original, which is the backlink source.
			const sourceId = cacheService.getMirrorOriginal(id) ?? id;
			const before = cacheService.getNode(sourceId);
			const effects = saveEffects(ctx, before, name, note);
			writer.local.updateNode(
				id,
				{
					...(name === undefined
						? {}
						:
							{
								name,
							}),
					...(note === undefined
						? {}
						:
							{
								note,
							}),
					...(layoutMode === undefined
						? {}
						:
							{
								layoutMode,
							}),
					metadata: [
						...(numberedStart === undefined
							? []
							: [
									{
										path: ["numbered_start"],
										value: numberedStart ?? undefined,
									},
								]),
						...tableChanges,
					],
				},
			);
			const beforeText = `${before?.name ?? ""} ${before?.note ?? ""}`;
			const afterText = `${name ?? before?.name ?? ""} ${note ?? before?.note ?? ""}`;
			const synced =
				(name !== undefined || note !== undefined) && backlinksNeedSync(ctx, sourceId, beforeText, afterText)
					? writer.local.syncBacklinks([sourceId])
					: undefined;
			const node = await readNodeDto(ctx, id);
			if (node === undefined)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}
			return ok(
				toJson(
					{
						node,
						effects:
						{
							...effects,
							backlinkTargets: [
								...new Set([
									...effects.backlinkTargets,
									...(synced?.created ?? []).map((item) => item.targetId),
									...(synced?.deleted ?? []).map((item) => item.targetId),
								]),
							],
						},
					} satisfies UpdateNodeResponse,
				),
			);
		},
	},
);

// DELETE /api/v1/nodes/:id - Delete node
export const nodesDelete = defineOp(
	{
		input: z.object(
			{
				id: z.string(),
			},
		),
		output: NoContentSchema,
		async run(ctx, {id: rawId})
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					500,
					{
						error: WRITE_CLIENT_REQUIRED,
					},
				);
			}

			const id = resolveNodeId(ctx, rawId);
			if (!id)
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}

			// Verify the node exists before attempting to delete
			if (!ctx.cacheService.getNode(id))
			{
				return fail(
					404,
					{
						error: "Node not found",
					},
				);
			}

			writer.local.deleteNode(id, await localDeletePlan(ctx, id));
			return ok(null);
		},
	},
);

type CompletionOp = "complete" | "uncomplete";

/** Completes or uncompletes a row, answering it from the cache: a mirror keeps its own id and parent and carries its original's completion. */
function completionOp(operation: CompletionOp)
{
	return defineOp(
		{
			input: z.object(
				{
					id: z.string(),
				},
			),
			output: NodeEnvelopeSchema,
			async run(ctx, {id: rawId})
			{
				const writer = getNodeWriter(ctx);
				if (!writer)
				{
					return fail(
						500,
						{
							error: WRITE_CLIENT_REQUIRED,
						},
					);
				}

				const id = resolveNodeId(ctx, rawId);
				if (!id)
				{
					return fail(
						404,
						{
							error: "Node not found",
						},
					);
				}

				// Verify the node exists before attempting to change it
				const existingNode = ctx.cacheService.getNode(id);
				if (!existingNode)
				{
					return fail(
						404,
						{
							error: "Node not found",
						},
					);
				}

				if (operation === "complete")
				{
					writer.local.completeNode(id);
				}
				else
				{
					writer.local.uncompleteNode(id);
				}
				const node = await readNodeDto(ctx, id);
				return node === undefined
					? fail(
							404,
							{
								error: "Node not found",
							},
						)
					: ok(
							toJson(
								{
									node,
								},
							),
						);
			},
		},
	);
}

// POST /api/v1/nodes/:id/complete - Mark node as completed
export const nodesComplete = completionOp("complete");

// POST /api/v1/nodes/:id/uncomplete - Mark node as not completed
export const nodesUncomplete = completionOp("uncomplete");

/** Restore: reopen the node's subtree from its last closed versions; the local tables are the truth. */
async function restoreLocally(
	ctx: ServerContext,
	local: LocalTreeWriter,
	body:
	{
		id: string;
		parent_id?: string | null | undefined;
		index?: number | undefined;
	},
): Promise<OpResult<z.output<typeof NodeEnvelopeSchema>>>
{
	const {id} = body;
	if (ctx.cacheService.getNode(id))
	{
		return fail(
			409,
			{
				error: "Node is not deleted",
			},
		);
	}
	const input: LocalRestoreInput =
	{
		id,
	};
	if (body.parent_id !== undefined)
	{
		const parent = parseParent(ctx, body.parent_id);
		if (!parent.ok)
		{
			return fail(
				parent.status,
				{
					error: parent.error,
				},
			);
		}
		if (parent.parentId !== null && !ctx.cacheService.getNode(parent.parentId))
		{
			return fail(
				404,
				{
					error: "Parent node not found",
				},
			);
		}
		input.parentId = parent.parentId;
	}
	if (body.index !== undefined)
	{
		input.index = body.index;
	}
	if (!local.restoreNode(input))
	{
		return fail(
			404,
			{
				error: "Node not found",
			},
		);
	}
	const node = await readNodeDto(ctx, id);
	return node === undefined
		? fail(
				404,
				{
					error: "Node not found",
				},
			)
		: ok(
				toJson(
					{
						node,
					},
				),
			);
}

// POST /api/v1/nodes/:id/restore - Bring back a deleted node under its ORIGINAL id
export const nodesRestore = defineOp(
	{
		input: z.object(
			{
				id: z.string(),
				parent_id: ParentIdSchema.optional(),
				index: IndexSchema,
			},
		),
		output: NodeEnvelopeSchema,
		async run(ctx, body)
		{
			const writer = getNodeWriter(ctx);
			if (!writer)
			{
				return fail(
					500,
					{
						error: WRITE_CLIENT_REQUIRED,
					},
				);
			}
			return restoreLocally(ctx, writer.local, body);
		},
	},
);
