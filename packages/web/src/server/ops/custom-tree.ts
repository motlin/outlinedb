import {z} from "zod";
import {collectCustomSections, findCustomRoot, readCustomTree} from "../custom-tree.js";
import {defineOp, ok, toJson} from "./define.js";

const CustomNodeSchema = z.strictObject({
	name: z.string(),
	completed: z.boolean(),
	get children(): z.ZodArray<typeof CustomNodeSchema> {
		return z.array(CustomNodeSchema);
	},
});

/** The Custom root, its children for the root picker, and its grammar sections. */
export const CustomTreeResponseSchema = z.strictObject({
	rootId: z.string().nullable(),
	rootChildren: z.array(z.strictObject({id: z.string(), name: z.string()})),
	/**
	 * The ids whose write can change this answer: every top-level node (one may become the root) and every node read
	 * under the root. The client refetches the tree only after a write naming one of them or a top-level parent.
	 */
	watchedIds: z.array(z.string()),
	sections: z.record(z.string(), z.array(CustomNodeSchema)),
});

const GRAMMARS: ReadonlySet<string> = new Set(["Hotkeys", "Themes"]);

/** The grammar sections under the Custom root, read from the cache (never written). */
export const customTreeGet = defineOp({
	input: z.object({rootId: z.string().optional()}),
	output: CustomTreeResponseSchema,
	run(ctx, {rootId: requested}) {
		const {cacheService} = ctx;
		const topLevel = cacheService.getChildren(null);
		const rootId = findCustomRoot(topLevel, requested);
		const watched = new Set(topLevel.map(({id}) => id));
		const root = rootId === null ? null : readCustomTree(cacheService, rootId, watched);
		const rootChildren =
			rootId === null ? [] : cacheService.getChildren(rootId).map(({id, name}) => ({id, name: name ?? ""}));
		return ok(
			toJson({rootId, rootChildren, watchedIds: [...watched], sections: collectCustomSections(root, GRAMMARS)}),
		);
	},
});
