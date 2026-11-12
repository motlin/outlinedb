/**
 * Replays the file-attachment part of `/push_and_poll` transaction-log ops onto `s3_files`, so a photo or file another
 * client attaches lands in the cache without a whole-tree read: a `bulk_create` tree's own `metadata.s3File`, and
 * `edit` metadata patches under `s3File` (a whole-object add, a field change such as `isDeleted`, or a remove).
 */

import {z} from "zod";
import {applyMetadataPatches} from "../internal/metadata-patch.js";
import type {MetadataPatch} from "../internal/metadata-patch.js";
import {readInternalMetadata, writeS3Files} from "./internal-metadata.js";
import type {UnitOfWork} from "./node-composite.js";
import type {LoggedOp} from "./relationship-log.js";

interface CreatedTree
{
	id: string;
	metadata?: unknown;
	ch?: CreatedTree[] | undefined;
}

const CreatedTreeSchema: z.ZodType<CreatedTree> = z.lazy(() =>
	z
		.object(
			{
				id: z.string(),
				metadata: z.unknown().optional(),
				ch: z.array(CreatedTreeSchema).optional(),
			},
		)
		.loose(),
);

const BulkCreateSchema = z
	.object(
		{
			project_trees: z.union([
				z.string().transform((json, context): unknown =>
				{
					try
					{
						return JSON.parse(json);
					}
					catch
					{
						context.addIssue(
							{
								code: "custom",
								message: "project_trees is not JSON",
							},
						);
						return z.NEVER;
					}
				}),
				z.array(z.unknown()),
			]),
		},
	)
	.loose();

const PatchSchema = z.union([
	z
		.object(
			{
				op: z.literal("remove"),
				path: z.array(z.union([z.string(), z.number()]).transform(String)),
			},
		)
		.loose(),
	z
		.object(
			{
				op: z.enum(["add", "replace"]),
				path: z.array(z.union([z.string(), z.number()]).transform(String)),
				value: z.unknown(),
			},
		)
		.loose(),
]);

const EditSchema = z
	.object(
		{
			projectid: z.string(),
			metadataPatches: z.array(PatchSchema).optional(),
		},
	)
	.loose();

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply `ops`, in order, to the `s3_files` rows of the nodes whose attachment they set, in the caller's unit of work.
 * Each node's row is versioned at most once, and only when its attachment changed.
 */
export function applyFileOps(unitOfWork: UnitOfWork, ops: readonly LoggedOp[]): void
{
	const files = new Map<string, unknown>();
	const current = (id: string): unknown =>
		files.has(id) ? files.get(id) : readInternalMetadata(unitOfWork.tx, [id]).get(id)?.s3File;
	for (const op of ops)
	{
		if (op.type === "bulk_create")
		{
			const create = BulkCreateSchema.safeParse(op.data);
			const trees = z.array(CreatedTreeSchema).safeParse(create.success ? create.data.project_trees : []);
			const visit = (nodes: readonly CreatedTree[]): void =>
			{
				for (const tree of nodes)
				{
					if (isRecord(tree.metadata) && Object.hasOwn(tree.metadata, "s3File"))
					{
						files.set(tree.id, tree.metadata.s3File);
					}
					visit(tree.ch ?? []);
				}
			};
			visit(trees.success ? trees.data : []);
		}
		else if (op.type === "edit")
		{
			const edit = EditSchema.safeParse(op.data);
			if (!edit.success)
			{
				continue;
			}
			const patches: MetadataPatch[] = (edit.data.metadataPatches ?? [])
				.filter((patch) => patch.path[0] === "s3File")
				.map((patch) =>
					patch.op === "remove"
						?
							{
								op: "remove",
								path: patch.path,
							}
						:
							{
								op: patch.op,
								path: patch.path,
								value: patch.value,
							},
				);
			if (patches.length === 0)
			{
				continue;
			}
			const id = edit.data.projectid;
			const before = current(id);
			try
			{
				files.set(
					id,
					applyMetadataPatches(
						before === undefined
							? {}
							:
								{
									s3File: before,
								},
						patches,
					).s3File,
				);
			}
			catch
			{
				// A field patch on a node with no attachment has nothing to change.
			}
		}
	}
	if (files.size > 0)
	{
		writeS3Files(unitOfWork, files);
	}
}
