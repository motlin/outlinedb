/**
 * Stars (starred pages and saved searches), stored in upstream's account-global root metadata: through the internal
 * API when there is one, so they match workflowy.com, and in the local tables otherwise.
 */

import {z} from "zod";
import {locationKey} from "@outlinedb/shared";
import type {Star} from "@outlinedb/shared";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {
	orderChanges,
	renameChanges,
	savedViewsMap,
	starChanges,
	starsFromRootMeta,
	toggleSavedView,
	unstarChanges,
} from "@outlinedb/shared/internal";
import type {StarNodes} from "@outlinedb/shared/internal";
import {withAccountState} from "../account-state.js";
import type {AccountState} from "../account-state.js";
import type {ServerContext} from "../context.js";
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

async function savedViewsJson(adapter: AccountState): Promise<string | undefined> {
	const json = await adapter.getSetting("saved_views_json");
	return typeof json === "string" ? json : undefined;
}

async function readStars(ctx: ServerContext, adapter: AccountState) {
	return starsFromRootMeta(await adapter.getRootMeta([]), starNodes(ctx), await savedViewsJson(adapter));
}

/**
 * Upstream `toggleLocation`: toggle `key` in root metadata and in the legacy saved views
 * (`saved_views_json`), whose map an unsynced account copies into its locations.
 */
async function toggleStar(ctx: ServerContext, adapter: AccountState, key: string, starred: boolean) {
	const legacy = toggleSavedView(await savedViewsJson(adapter), key, starred, starNodes(ctx));
	const meta = await adapter.getRootMeta([]);
	const toggle = starred ? starChanges : unstarChanges;
	await adapter.setRootMetaValues(toggle(meta, key, savedViewsMap(legacy.json)));
	if (legacy.delta !== "{}") {
		await adapter.setSavedViews(legacy.json, legacy.delta);
	}
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

/** The stars and each starred node once. */
export const StarsResponseSchema = z.strictObject({stars: z.array(StarSchema), nodes: z.array(NodeResponseSchema)});

/** `{stars, nodes}`: each starred node once, as `GET /nodes/:id` returns it, so the left bar's rows need no request of their own. */
export function starsListWith(readNode: ReadNode) {
	return defineOp({
		input: z.object({}),
		output: StarsResponseSchema,
		async run(ctx) {
			return withAccountState(ctx, async (adapter) => {
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
		return withAccountState(ctx, async (adapter) => {
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
		return withAccountState(ctx, async (adapter) => {
			if (locationKey({nodeId, query}) !== key) {
				return fail(400, {error: "key must equal the location key of {nodeId, query}"});
			}
			if (nodeId !== null && !starNodes(ctx).exists(nodeId)) {
				return fail(404, {error: `Node not found: ${nodeId}`});
			}
			await toggleStar(ctx, adapter, key, true);
			const star = (await readStars(ctx, adapter)).find((s) => s.key === key);
			return ok(toJson(star ?? null), {created: true});
		});
	},
});

export const starsRemove = defineOp({
	input: z.object({key: z.string()}),
	output: NoContentSchema,
	async run(ctx, {key}) {
		return withAccountState(ctx, async (adapter) => {
			await toggleStar(ctx, adapter, key, false);
			return ok(null);
		});
	},
});

export const starsRename = defineOp({
	input: z.object({key: z.string(), name: z.string().nullable()}),
	output: NoContentSchema,
	async run(ctx, {key, name}) {
		return withAccountState(ctx, async (adapter) => {
			await adapter.setRootMetaValues(renameChanges(key, name));
			return ok(null);
		});
	},
});
