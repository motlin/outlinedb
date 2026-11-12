import {z} from "zod";

// ============================================================================
// Base Types - What Workflowy API returns
// ============================================================================

/**
 * Zod schema for a flat node as returned by the Workflowy API.
 * This is the raw data structure from Workflowy with no CLI additions.
 */
export const WorkflowyNodeSchema = z
	.object(
		{
			id: z.string(),
			name: z.string(),
			note: z.string().nullable().optional(),
			parent_id: z.string().nullable().optional(),
			priority: z.number(),
			completed: z.boolean().optional(),
			data: z
				.object(
					{
						layoutMode: z.string().optional(),
						ai: z
							.object(
								{
									inChat: z.boolean(),
								},
							)
							.optional(),
						isReferencesRoot: z.boolean().optional(),
					},
				)
				.optional(),
			createdAt: z.number(),
			modifiedAt: z.number().nullable(),
			completedAt: z.number().nullable().optional(),
		},
	)
	.strict();

export const ApiResponseSchema = z
	.object(
		{
			nodes: z.array(WorkflowyNodeSchema).optional(),
		},
	)
	.strict();

export const CreateNodeResponseSchema = z
	.object(
		{
			item_id: z.string(),
		},
	)
	.strict();

export const CreateMirrorResponseSchema = z
	.object(
		{
			item_id: z.string(),
			origin_id: z.string(),
		},
	)
	.strict();

export const GetNodeResponseSchema = z
	.object(
		{
			node: WorkflowyNodeSchema,
		},
	)
	.strict();

export const CompletionStatusResponseSchema = z
	.object(
		{
			status: z.string(),
		},
	)
	.strict();

/**
 * A flat node as returned by the Workflowy API.
 * This is the base type with no CLI additions - just what Workflowy returns.
 */
export type WorkflowyNode = z.infer<typeof WorkflowyNodeSchema>;

// ============================================================================
// Enhanced Types - CLI additions for tree output and link resolution
// ============================================================================

/**
 * Represents a resolved internal link target with its short ID.
 * Used when `--follow-links` resolves `<a href="workflowy.com/#/shortId">` links.
 *
 * This is an enhanced type that adds CLI-specific fields to WorkflowyNode.
 */
type LinkTarget = WorkflowyNode &
{
	/** The 12-character short ID from the Workflowy URL (last 12 hex chars of UUID) */
	shortId: string;
	/** Recursively enhanced children of this link target */
	children?: EnhancedWorkflowyNode[];
};

/**
 * Enhanced WorkflowyNode with CLI additions for tree output and link resolution.
 *
 * This type extends the base WorkflowyNode with fields added by the CLI:
 * - `children`: Recursive children for tree output (when using `--depth > 0`)
 * - `linkTargets`: Resolved internal links (when using `--follow-links`)
 *
 * Use WorkflowyNode for raw API data, EnhancedWorkflowyNode for CLI output.
 */
export type EnhancedWorkflowyNode = WorkflowyNode &
{
	/** Recursive children for tree output. Present when fetching with `--depth > 0`. */
	children?: EnhancedWorkflowyNode[];
	/** Resolved internal link targets when `--follow-links` is used. */
	linkTargets?: LinkTarget[];
};
