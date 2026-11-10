import {z} from "zod";
import {LocalTreeWriter, planBlockSlot} from "@outlinedb/shared/cache";
import type {LocalRestoreInput, SlotPlan} from "@outlinedb/shared/cache";
import type {RestoreInput, WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {calendarParentContext} from "@outlinedb/shared/calendar-lookup";
import {adoptAfterCreate, calendarAdoptWarning, datesInName, linkedSourcesInSubtree} from "@outlinedb/shared/internal";
import {HOME_TARGET} from "@outlinedb/shared/types";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import type {NodeResponse, SaveEffects, UpdateNodeResponse} from "../../node-types.js";
import {backlinksNeedSync, backlinkTargetsOfSource} from "../backlinks.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import type {OpResult} from "./define.js";
import type {ServerContext} from "../context.js";
import {
	CreateNodeResponseSchema,
	HomeResponseSchema,
	NoContentSchema,
	NodeEnvelopeSchema,
	UpdateNodeResponseSchema,
} from "./schemas.js";
import {
	adapterParent,
	childIds,
	countChildren,
	getAdapter,
	getApiClient,
	getNodeWriter,
	AfterIdSchema,
	IndexSchema,
	LegacyPositionSchema,
	ParentIdSchema,
	slotIndex,
	parseParent,
	publicEnd,
	publicMovePosition,
	readNodeDto,
	resolveNodeId,
	saveEffects,
} from "./nodes-shared.js";

/** A text field the handler has always passed through as sent: typed for the compiler, not checked at runtime. */
const unvalidatedText = z.custom<string>(() => true).optional();

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const WRITE_CLIENT_REQUIRED = "WORKFLOWY_API_KEY environment variable is required";

/** A `layoutMode` as a metadata value: `"bullets"` is upstream's default, stored as no key. */
function layoutModeValue(layoutMode: string): string | undefined {
	return layoutMode === "bullets" ? undefined : layoutMode;
}

/** A metadata write under `table`; an omitted value deletes the key. */
const TableSetSchema = z.array(z.object({path: z.tuple([z.literal("table")], z.string()), value: z.json().optional()}));

/** The public API's node in Workflowy response format, for a host without the cache row. */
function wireNodeResponse(node: WorkflowyNode, parentId: string | null, hasUncompletedChildren: boolean): NodeResponse {
	return {
		id: node.id,
		parent_id: parentId,
		name: node.name,
		note: node.note ?? null,
		priority: node.priority,
		data: {layoutMode: node.data?.layoutMode ?? null},
		numberedStart: null,
		createdAt: node.createdAt,
		modifiedAt: node.modifiedAt,
		completedAt: node.completedAt ?? null,
		hasChildren: true,
		...(hasUncompletedChildren ? {hasUncompletedChildren: true} : {}),
		isMirror: false,
		originalNodeId: null,
		attachment: null,
		defaultToBottom: false,
		calendar: null,
		table: null,
	};
}

/**
 * Tag a dated row just created under a 📆 Calendar month as that day, as upstream's `mb1` hook does for web edits,
 * so workflowy.com uses it as the day. Answers the warning to return when it needed tagging but there is no
 * internal adapter to write the metadata.
 */
async function adoptUnderCalendar(
	ctx: ServerContext,
	adapter: WorkflowyInternalAdapter | undefined,
	created: {id: string; name: string; parentId: string | null},
): Promise<string | undefined> {
	const {id, name, parentId} = created;
	// Most creates are undated (every empty row the web app adds), so skip the calendar walk for them.
	if (parentId === null || datesInName(name).length === 0) {
		return undefined;
	}
	const context = calendarParentContext({db: ctx.db, cache: ctx.cacheService}, parentId);
	const adoption = await adoptAfterCreate({id, name, context, adapter});
	return adoption.status === "unadoptable" ? calendarAdoptWarning(name) : undefined;
}

/** The create reply for a node the cache now holds. */
async function createdNodeResult(
	ctx: ServerContext,
	id: string,
): Promise<OpResult<z.output<typeof CreateNodeResponseSchema>>> {
	const node = await readNodeDto(ctx, id);
	if (node === undefined) {
		return fail(500, {error: `Created node ${id} is missing from the cache`});
	}
	return ok(toJson({node}), {created: true});
}

// POST /api/v1/nodes - Create node at an exact `index` among all siblings (omitted = bottom)
export const nodesCreate = defineOp({
	input: z.object({
		parent_id: ParentIdSchema,
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
		 * optimistic row before this reply. Honored through the internal API only; the
		 * public-API fallback assigns its own id (the reply carries the real one).
		 */
		id: z.string().regex(CLIENT_ID_PATTERN).optional(),
	}),
	output: CreateNodeResponseSchema,
	async run(ctx, body) {
		const writer = getNodeWriter(ctx);
		if (!writer) {
			return fail(500, {error: WRITE_CLIENT_REQUIRED});
		}
		const {name, note, layoutMode, after_id: afterId} = body;
		const parent = parseParent(ctx, body.parent_id);
		if (!parent.ok) {
			return fail(parent.status, {error: parent.error});
		}
		const {parentId} = parent;
		const index = slotIndex(body.index, body.position);
		if (body.id !== undefined && ctx.cacheService.getNode(body.id)) {
			return fail(409, {error: `Node already exists: ${body.id}`});
		}

		if (writer.mode === "standalone") {
			if (parentId !== null && !ctx.cacheService.getNode(parentId)) {
				return fail(404, {error: "Parent node not found"});
			}
			const {id} = writer.local.createAt({
				parentId,
				...(index === undefined ? {} : {index}),
				...(afterId === undefined || index === undefined ? {} : {afterId}),
				name,
				...(body.id === undefined ? {} : {id: body.id}),
				...(note === undefined ? {} : {note}),
				...(layoutMode === undefined ? {} : {layoutMode}),
			});
			return createdNodeResult(ctx, id);
		}
		const {client} = writer;
		const count = countChildren(ctx, parentId);

		const adapter = getAdapter(ctx);
		if (adapter) {
			const {id} = await adapter.createAt({
				parentId: adapterParent(parentId),
				...(index === undefined ? {} : {index}),
				...(afterId === undefined || index === undefined ? {} : {afterId}),
				name,
				...(body.id === undefined ? {} : {id: body.id}),
				...(note === undefined ? {} : {note}),
				...(layoutMode === undefined ? {} : {metadata: {layoutMode}}),
			});
			await adoptUnderCalendar(ctx, adapter, {id, name, parentId});
			return createdNodeResult(ctx, id);
		}

		// Without the internal API a middle slot is the nearer end plus a rotation of the siblings on the shorter side.
		const end = publicEnd(index, count);
		const rotation: SlotPlan =
			end === undefined
				? planBlockSlot(childIds(ctx, parentId), [], index ?? count)
				: {position: end, siblingIds: []};
		const createdNode = await client.createNode({
			parent_id: parentId ?? HOME_TARGET,
			name,
			note,
			layoutMode,
			position: rotation.position,
		});
		for (const siblingId of rotation.siblingIds) {
			await client.moveNode(siblingId, parentId, publicMovePosition(rotation.position));
		}
		const warning = await adoptUnderCalendar(ctx, undefined, {id: createdNode.id, name, parentId});
		return ok(
			toJson({node: wireNodeResponse(createdNode, parentId, true), ...(warning === undefined ? {} : {warning})}),
			{created: true},
		);
	},
});

// PATCH (or POST) /api/v1/nodes/home - Set Home's layoutMode through the root metadata
export const nodesSetHome = defineOp({
	/** Upstream offers only these layouts at Home. */
	input: z.strictObject({layoutMode: z.enum(["bullets", "board"])}),
	output: HomeResponseSchema,
	async run(ctx, {layoutMode}) {
		const changes = [{path: ["layoutMode"], value: layoutModeValue(layoutMode)}];
		if (ctx.mode === "standalone") {
			new LocalTreeWriter(ctx.db).setNodeMetaValues(HOME_TARGET, changes);
			return ok({layoutMode});
		}
		const adapter = getAdapter(ctx);
		if (!adapter) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}
		await adapter.setNodeMetaValues(HOME_TARGET, changes);
		return ok({layoutMode});
	},
});

// PATCH (or POST) /api/v1/nodes/:id - Update node
export const nodesUpdate = defineOp({
	input: z.object({
		id: z.string(),
		name: unvalidatedText,
		note: unvalidatedText,
		layoutMode: unvalidatedText,
		numberedStart: z.number().int().nullable().optional(),
		tableSet: TableSetSchema.optional(),
	}),
	output: UpdateNodeResponseSchema,
	async run(ctx, body) {
		const writer = getNodeWriter(ctx);
		if (!writer) {
			return fail(500, {error: WRITE_CLIENT_REQUIRED});
		}

		const id = resolveNodeId(ctx, body.id);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}
		const {name, note, layoutMode, numberedStart, tableSet} = body;

		// Validate that at least one field is provided
		if (
			name === undefined &&
			note === undefined &&
			layoutMode === undefined &&
			numberedStart === undefined &&
			tableSet === undefined
		) {
			return fail(400, {error: "At least one of name, note, layoutMode, numberedStart, or tableSet is required"});
		}
		const tableChanges = (tableSet ?? []).map(({path, value}) => ({path, value}));

		const {cacheService} = ctx;
		// Get current node to preserve parentId and verify existence
		const existingNode = cacheService.getNode(id);
		if (!existingNode) {
			return fail(404, {error: "Node not found"});
		}

		if (writer.mode === "standalone") {
			// Local backlinks come later: the effects report changed links, but no backlink items are written.
			const effects = saveEffects(
				ctx,
				cacheService.getNode(cacheService.getMirrorOriginal(id) ?? id),
				name,
				note,
			);
			writer.local.updateNode(id, {
				...(name === undefined ? {} : {name}),
				...(note === undefined ? {} : {note}),
				...(layoutMode === undefined ? {} : {layoutMode}),
				metadata: [
					...(numberedStart === undefined
						? []
						: [{path: ["numbered_start"], value: numberedStart ?? undefined}]),
					...tableChanges,
				],
			});
			const node = await readNodeDto(ctx, id);
			if (node === undefined) {
				return fail(404, {error: "Node not found"});
			}
			return ok(toJson({node, effects} satisfies UpdateNodeResponse));
		}
		const {client} = writer;

		// Metadata goes through the internal API as one edit when it is configured;
		// without it only layoutMode can be written (through the public API).
		const adapter = getAdapter(ctx);
		if (adapter) {
			const changes = [
				...(layoutMode === undefined ? [] : [{path: ["layoutMode"], value: layoutModeValue(layoutMode)}]),
				...(numberedStart === undefined ? [] : [{path: ["numbered_start"], value: numberedStart ?? undefined}]),
				...tableChanges,
			];
			let effects: SaveEffects = {backlinkTargets: [], dates: false};
			if (name !== undefined || note !== undefined) {
				// Text lives on a mirror's original, which is the backlink source.
				const sourceId = cacheService.getMirrorOriginal(id) ?? id;
				const before = cacheService.getNode(sourceId);
				effects = saveEffects(ctx, before, name, note);
				await client.updateNode(id, {
					...(name === undefined ? {} : {name}),
					...(note === undefined ? {} : {note}),
				});
				// Upstream's client keeps backlinks in step with a source's links; the whole-tree
				// sync runs only when a link moved or a linked target lacks its backlink.
				const beforeText = `${before?.name ?? ""} ${before?.note ?? ""}`;
				const afterText = `${name ?? before?.name ?? ""} ${note ?? before?.note ?? ""}`;
				if (backlinksNeedSync(ctx, sourceId, beforeText, afterText)) {
					const existing = backlinkTargetsOfSource(ctx.db, sourceId);
					const synced = await adapter.syncBacklinks([sourceId]);
					const touched = [
						...synced.created.map((created) => created.targetId),
						...synced.deleted.flatMap((itemId) => existing.get(itemId) ?? []),
					];
					effects = {...effects, backlinkTargets: [...new Set([...effects.backlinkTargets, ...touched])]};
				}
			}
			if (changes.length > 0) {
				await adapter.setNodeMetaValues(id, changes);
			}
			const node = await readNodeDto(ctx, id);
			if (node === undefined) {
				return fail(404, {error: "Node not found"});
			}
			return ok(toJson({node, effects} satisfies UpdateNodeResponse));
		}
		if (numberedStart !== undefined || tableChanges.length > 0) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}

		const effects = saveEffects(ctx, cacheService.getNode(cacheService.getMirrorOriginal(id) ?? id), name, note);
		const updatedNode = await client.updateNode(id, {
			...(name === undefined ? {} : {name}),
			...(note === undefined ? {} : {note}),
			...(layoutMode === undefined ? {} : {layoutMode}),
		});
		return ok(
			toJson({
				node: wireNodeResponse(updatedNode, existingNode.parentId, true),
				effects,
			} satisfies UpdateNodeResponse),
		);
	},
});

// DELETE /api/v1/nodes/:id - Delete node
export const nodesDelete = defineOp({
	input: z.object({id: z.string()}),
	output: NoContentSchema,
	async run(ctx, {id: rawId}) {
		const writer = getNodeWriter(ctx);
		if (!writer) {
			return fail(500, {error: WRITE_CLIENT_REQUIRED});
		}

		const id = resolveNodeId(ctx, rawId);
		if (!id) {
			return fail(404, {error: "Node not found"});
		}

		// Verify the node exists before attempting to delete
		if (!ctx.cacheService.getNode(id)) {
			return fail(404, {error: "Node not found"});
		}

		if (writer.mode === "standalone") {
			writer.local.deleteNode(id);
			return ok(null);
		}
		const {client} = writer;

		// Upstream's client deletes a deleted source's backlink items; read the linked
		// sources before the delete drops the subtree from the cache.
		const adapter = getAdapter(ctx);
		const linked = adapter ? linkedSourcesInSubtree(ctx.db, id) : undefined;
		await client.deleteNode(id);
		if (adapter && linked && linked.ids.length > 0) {
			await adapter.deleteBacklinksOf(linked);
		}
		return ok(null);
	},
});

type CompletionOp = "complete" | "uncomplete";

/** Completes or uncompletes a row, answering it from the cache: a mirror keeps its own id and parent and carries its original's completion. */
function completionOp(operation: CompletionOp) {
	return defineOp({
		input: z.object({id: z.string()}),
		output: NodeEnvelopeSchema,
		async run(ctx, {id: rawId}) {
			const writer = getNodeWriter(ctx);
			if (!writer) {
				return fail(500, {error: WRITE_CLIENT_REQUIRED});
			}

			const id = resolveNodeId(ctx, rawId);
			if (!id) {
				return fail(404, {error: "Node not found"});
			}

			// Verify the node exists before attempting to change it
			const existingNode = ctx.cacheService.getNode(id);
			if (!existingNode) {
				return fail(404, {error: "Node not found"});
			}

			if (writer.mode === "standalone") {
				if (operation === "complete") {
					writer.local.completeNode(id);
				} else {
					writer.local.uncompleteNode(id);
				}
				const node = await readNodeDto(ctx, id);
				return node === undefined ? fail(404, {error: "Node not found"}) : ok(toJson({node}));
			}
			const {client} = writer;
			const changed = await (operation === "complete" ? client.completeNode(id) : client.uncompleteNode(id));

			const cached = await readNodeDto(ctx, id);
			if (cached) {
				return ok(toJson({node: cached}));
			}
			return ok(toJson({node: wireNodeResponse(changed, existingNode.parentId, operation === "uncomplete")}));
		},
	});
}

// POST /api/v1/nodes/:id/complete - Mark node as completed
export const nodesComplete = completionOp("complete");

// POST /api/v1/nodes/:id/uncomplete - Mark node as not completed
export const nodesUncomplete = completionOp("uncomplete");

/** Restore in a standalone account: reopen the node's subtree from its last closed versions; the cache is the truth. */
async function restoreLocally(
	ctx: ServerContext,
	body: {id: string; parent_id?: string | null | undefined; index?: number | undefined},
): Promise<OpResult<z.output<typeof NodeEnvelopeSchema>>> {
	const {id} = body;
	if (ctx.cacheService.getNode(id)) {
		return fail(409, {error: "Node is not deleted"});
	}
	const input: LocalRestoreInput = {id};
	if (body.parent_id !== undefined) {
		const parent = parseParent(ctx, body.parent_id);
		if (!parent.ok) {
			return fail(parent.status, {error: parent.error});
		}
		if (parent.parentId !== null && !ctx.cacheService.getNode(parent.parentId)) {
			return fail(404, {error: "Parent node not found"});
		}
		input.parentId = parent.parentId;
	}
	if (body.index !== undefined) {
		input.index = body.index;
	}
	if (!new LocalTreeWriter(ctx.db).restoreNode(input)) {
		return fail(404, {error: "Node not found"});
	}
	const node = await readNodeDto(ctx, id);
	return node === undefined ? fail(404, {error: "Node not found"}) : ok(toJson({node}));
}

// POST /api/v1/nodes/:id/restore - Bring back a deleted node under its ORIGINAL id
export const nodesRestore = defineOp({
	input: z.object({id: z.string(), parent_id: ParentIdSchema.optional(), index: IndexSchema}),
	output: NodeEnvelopeSchema,
	async run(ctx, body) {
		if (ctx.mode === "standalone") {
			return restoreLocally(ctx, body);
		}
		const adapter = getAdapter(ctx);
		const apiClient = getApiClient(ctx);
		if (!adapter || !apiClient) {
			return fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
		}

		const {id} = body;
		// Ask Workflowy, not the cache: a node deleted on workflowy.com lingers in a stale cache.
		if ((await apiClient.findNode(id)) !== null) {
			return fail(409, {error: "Node is not deleted"});
		}
		const input: RestoreInput = {id};
		if (body.parent_id !== undefined) {
			const parent = parseParent(ctx, body.parent_id);
			if (!parent.ok) {
				return fail(parent.status, {error: parent.error});
			}
			input.parentId = adapterParent(parent.parentId);
		}
		if (body.index !== undefined) {
			input.index = body.index;
		}

		// End the stale rows (the whole cached subtree) so the restore's refresh stores only what came back.
		if (ctx.cacheService.getNode(id)) {
			ctx.cacheService.deleteNode(id);
		}
		await adapter.restore(input);
		const node = await readNodeDto(ctx, id);
		if (node === undefined) {
			return fail(500, {error: `Restored node ${id} is missing from the cache`});
		}
		return ok(toJson({node}));
	},
});
