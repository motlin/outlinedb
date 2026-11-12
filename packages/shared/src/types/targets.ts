import {z} from "zod";

/**
 * System target keys that the Workflowy API accepts in place of UUIDs.
 *
 * These magic strings can be used as parent_id in create/move operations,
 * eliminating the need to look up UUIDs for well-known locations.
 *
 * Currently only 'inbox' is supported by the API.
 */
export type SystemTargetKey = "inbox";

/**
 * All known system target keys.
 */
export const SYSTEM_TARGETS = ["inbox"] as const satisfies readonly SystemTargetKey[];

/**
 * Type guard to check if a string is a system target key.
 *
 * @param value - The string to check
 * @returns true if the value is a valid system target key
 *
 * @example
 * ```ts
 * if (isSystemTarget(parentId)) {
 *   // parentId is 'inbox' - can be used directly with API
 * } else {
 *   // parentId is a UUID - resolve via path or cache
 * }
 * ```
 */
export function isSystemTarget(value: string): value is SystemTargetKey
{
	return (SYSTEM_TARGETS as readonly string[]).includes(value);
}

/**
 * The parent id that names Home, the top level. The public API has no key for
 * it: a Home parent is sent by omitting `parent_id`, and the cache stores it as
 * a `null` parent.
 */
export const HOME_TARGET = "home";

/**
 * Zod schema for a single target in the /api/v1/targets response.
 */
export const WorkflowyTargetSchema = z
	.object(
		{
			name: z.string(),
			id: z.string(),
		},
	)
	.strict();

/**
 * Zod schema for the /api/v1/targets response.
 */
export const TargetsResponseSchema = z
	.object(
		{
			targets: z.array(WorkflowyTargetSchema),
		},
	)
	.strict();

/**
 * A single target from the Workflowy targets API.
 *
 * The targets endpoint returns special locations like inbox with their UUIDs.
 * Note: We typically use target keys directly rather than fetching UUIDs.
 */
export type WorkflowyTarget = z.infer<typeof WorkflowyTargetSchema>;

/**
 * Response from the /api/v1/targets endpoint.
 */
export type TargetsResponse = z.infer<typeof TargetsResponseSchema>;
