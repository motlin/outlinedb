import {z} from "zod";
import {ChangeDetector, parseSince} from "@outlinedb/shared/changes";
import {defineOp, fail, ok, toJson} from "./define.js";

const NodeChangeSchema = z.strictObject(
	{
		id: z.string(),
		isNew: z.boolean(),
		isDeleted: z.boolean(),
		contentChanged: z.boolean(),
		parentChanged: z.boolean(),
		completionChanged: z.boolean(),
		noteChanged: z.boolean(),
		oldName: z.string().nullable(),
		oldNote: z.string().nullable(),
		oldParentId: z.string().nullable(),
		oldCompletedAt: z.string().nullable(),
		currentName: z.string().nullable(),
		currentNote: z.string().nullable(),
		currentParentId: z.string().nullable(),
		currentCompletedAt: z.string().nullable(),
		parentId: z.string().nullable(),
	},
);

const ChangeTreeNodeSchema = z.strictObject(
	{
		id: z.string(),
		name: z.string().nullable(),
		isContext: z.boolean(),
		change: NodeChangeSchema.nullable(),
		get children(): z.ZodArray<typeof ChangeTreeNodeSchema>
		{
			return z.array(ChangeTreeNodeSchema);
		},
	},
);

export const ChangesSchema = z.strictObject(
	{
		changes: z.array(NodeChangeSchema),
		tree: z.array(ChangeTreeNodeSchema),
		summary: z.strictObject(
			{
				added: z.number(),
				deleted: z.number(),
				changed: z.number(),
				moved: z.number(),
				completed: z.number(),
				uncompleted: z.number(),
			},
		),
		cutoffDate: z.string(),
	},
);

/** Changes since a relative or absolute cutoff (default one day), detected from the temporal tables. */
export const changesList = defineOp(
	{
		input: z.object(
			{
				since: z.string().default("1d"),
			},
		),
		output: ChangesSchema,
		run(ctx, {since})
		{
			let cutoffDate: Date;
			try
			{
				cutoffDate = parseSince(since);
			}
			catch
			{
				return fail(
					400,
					{
						error: `Invalid since parameter: "${since}"`,
					},
				);
			}
			const result = new ChangeDetector(ctx.db).detectChanges(cutoffDate);
			return ok(
				toJson(
					{
						changes: result.changes,
						tree: result.tree,
						summary: result.summary,
						cutoffDate: result.cutoffDate.toISOString(),
					},
				),
			);
		},
	},
);
