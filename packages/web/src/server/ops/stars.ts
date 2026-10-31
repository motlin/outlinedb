/**
 * Stars (starred pages and saved searches), stored in upstream's account-global root
 * metadata through the internal API, so they match workflowy.com.
 */

import {z} from "zod";
import {locationKey} from "@workflowy/shared";
import type {Star} from "@workflowy/shared";
import {stripHtmlTags} from "@workflowy/shared/html";
import {orderChanges, renameChanges, starChanges, starsFromRootMeta, unstarChanges} from "@workflowy/shared/internal";
import type {StarNodes, WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import type {ServerContext} from "../context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../internal-api-error.js";
import type {NodeResponse} from "../../node-types.js";
import {readNodeDto} from "./nodes-shared.js";
import {defineOp, fail, ok, toJson} from "./define.js";
import {NoContentSchema, NodeResponseSchema} from "./schemas.js";
import type {Json, OpResult} from "./define.js";

type ReadNode = (ctx: ServerContext, id: string) => Promise<NodeResponse | undefined>;

function starNodes(ctx: ServerContext): StarNodes {
	return {
		exists: (nodeId) => ctx.cacheService.getNode(nodeId) !== undefined,
		nameText: (nodeId) =>
			nodeId === null ? "Home" : stripHtmlTags(ctx.cacheService.getNode(nodeId)?.name ?? null),
	};
}

async function readStars(ctx: ServerContext, adapter: WorkflowyInternalAdapter) {
	return starsFromRootMeta(await adapter.getRootMeta([]), starNodes(ctx));
}

const StarSchema = z.strictObject({
	nodeId: z.string().nullable(),
	query: z.string().nullable(),
	key: z.string(),
	name: z.string().nullable(),
	position: z.number(),
});

/** Each starred node once, in star order, skipping Home and nodes the cache no longer holds. */
async function starredNodes(ctx: ServerContext, stars: readonly Star[], readNode: ReadNode): Promise<NodeResponse[]> {
	const ids = [...new Set(stars.flatMap((star) => (star.nodeId === null ? [] : [star.nodeId])))];
	const nodes = await Promise.all(ids.map(async (id) => readNode(ctx, id)));
	return nodes.filter((node) => node !== undefined);
}

/** Runs `body` with the internal adapter, or answers 503 when it is not configured. */
async function withAdapter<T extends Json>(
	ctx: ServerContext,
	body: (adapter: WorkflowyInternalAdapter) => Promise<OpResult<T>>,
): Promise<OpResult<T>> {
	const adapter = ctx.internalAdapter?.();
	return adapter ? body(adapter) : fail(503, {error: INTERNAL_API_NOT_CONFIGURED});
}

/** The stars and each starred node once. */
export const StarsResponseSchema = z.strictObject({stars: z.array(StarSchema), nodes: z.array(NodeResponseSchema)});

/** `{stars, nodes}`: each starred node once, as `GET /nodes/:id` returns it, so the left bar's rows need no request of their own. */
export function starsListWith(readNode: ReadNode) {
	return defineOp({
		input: z.object({}),
		output: StarsResponseSchema,
		async run(ctx) {
			return withAdapter(ctx, async (adapter) => {
				const stars = await readStars(ctx, adapter);
				return ok(toJson({stars, nodes: await starredNodes(ctx, stars, readNode)}));
			});
		},
	});
}

export const starsList = starsListWith(readNodeDto);

export const starsOrder = defineOp({
	input: z.object({keys: z.array(z.string())}),
	output: NoContentSchema,
	async run(ctx, {keys}) {
		return withAdapter(ctx, async (adapter) => {
			await adapter.setRootMetaValues(orderChanges(keys));
			return ok(null);
		});
	},
});

/** Stars a location; `key` must be the location key of `{nodeId, query}`. Answers the new star, created. */
export const starsSet = defineOp({
	input: z.object({key: z.string(), nodeId: z.string().nullable(), query: z.string().nullable()}),
	output: StarSchema.nullable(),
	async run(ctx, {key, nodeId, query}) {
		return withAdapter(ctx, async (adapter) => {
			if (locationKey({nodeId, query}) !== key) {
				return fail(400, {error: "key must equal the location key of {nodeId, query}"});
			}
			if (nodeId !== null && !starNodes(ctx).exists(nodeId)) {
				return fail(404, {error: `Node not found: ${nodeId}`});
			}
			await adapter.setRootMetaValues(starChanges(await adapter.getRootMeta([]), key));
			const star = (await readStars(ctx, adapter)).find((s) => s.key === key);
			return ok(toJson(star ?? null), {created: true});
		});
	},
});

export const starsRemove = defineOp({
	input: z.object({key: z.string()}),
	output: NoContentSchema,
	async run(ctx, {key}) {
		return withAdapter(ctx, async (adapter) => {
			await adapter.setRootMetaValues(unstarChanges(await adapter.getRootMeta([]), key));
			return ok(null);
		});
	},
});

export const starsRename = defineOp({
	input: z.object({key: z.string(), name: z.string().nullable()}),
	output: NoContentSchema,
	async run(ctx, {key, name}) {
		return withAdapter(ctx, async (adapter) => {
			await adapter.setRootMetaValues(renameChanges(key, name));
			return ok(null);
		});
	},
});
