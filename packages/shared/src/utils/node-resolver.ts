import type {WorkflowyApiClient} from "../api/index.js";
import {WorkflowyWriteThroughClient} from "../cache/index.js";
import type {CacheService} from "../cache/index.js";
import {HOME_TARGET, isSystemTarget} from "../types/index.js";
import {isShortId} from "../workflowy/index.js";

/**
 * Expands a 12-character short ID from the Workflowy URL into a full UUID.
 * Anything already UUID-shaped passes through untouched.
 *
 * @param id - A full UUID or a short ID
 * @param cacheService - The cache service holding the short-ID index
 * @returns The full UUID
 * @throws Error if a short ID has no match in the cache
 */
export function resolveIdOrShortId(id: string, cacheService: CacheService): string
{
	if (!isShortId(id))
	{
		return id;
	}

	const nodeId = cacheService.resolveShortIdToUuid(id);
	if (!nodeId)
	{
		throw new Error(`No node found for short ID: ${id}`);
	}
	return nodeId;
}

/**
 * Resolves a node ID from either a direct ID or a path.
 * First checks the cache, then falls back to the API.
 *
 * @param flags - Object containing optional `id` and `path` properties
 * @param flags.id - Direct node ID to use
 * @param flags.path - Comma-separated path to resolve
 * @param cacheService - The cache service for local lookup
 * @param apiClient - The API client for remote lookup
 * @returns The resolved node ID
 * @throws Error if the node cannot be found
 */
export async function resolveNodeId(
	flags:
	{
		id?: string;
		path?: string;
	},
	cacheService: CacheService,
	apiClient: WorkflowyApiClient,
): Promise<string>
{
	if (flags.id)
	{
		return resolveIdOrShortId(flags.id, cacheService);
	}

	if (flags.path === undefined)
	{
		throw new Error("Either --id or --path is required");
	}
	const nodePath = flags.path.split(",").map((s) => s.trim());
	const cachedNode = cacheService.findNodeByPath(nodePath);
	if (cachedNode)
	{
		return cachedNode.id;
	}

	const apiNode = await apiClient.findNodeByPath(nodePath);
	if (!apiNode)
	{
		throw new Error(`Node not found at path: ${nodePath.join(" > ")}`);
	}
	return apiNode.id;
}

/**
 * Resolves an optional parent node ID from either a direct ID or a path.
 * Returns undefined if neither id nor path is provided.
 *
 * @param flags - Object containing optional `id` and `path` properties
 * @param flags.id - Direct node ID to use
 * @param flags.path - Comma-separated path to resolve
 * @param cacheService - The cache service for local lookup
 * @param apiClient - The API client for remote lookup
 * @returns The resolved parent ID or undefined
 * @throws Error if a path is provided but the node cannot be found
 */
export async function resolveOptionalNodeId(
	flags:
	{
		id?: string;
		path?: string;
	},
	cacheService: CacheService,
	apiClient: WorkflowyApiClient,
): Promise<string | undefined>
{
	if (!flags.id && !flags.path)
	{
		return undefined;
	}
	return resolveNodeId(flags, cacheService, apiClient);
}

/**
 * Resolves a node path, creating missing segments as needed (like `mkdir -p`).
 * Walks the path from Home, finds existing nodes, and creates any missing ones,
 * including a missing first segment at the top level.
 *
 * @param path - Comma-separated path to resolve/create
 * @param cacheService - The cache service for local lookup and caching created nodes
 * @param apiClient - The API client for remote lookup and node creation
 * @returns The resolved node ID (creating path segments as needed)
 */
export async function resolveOrCreateNodePath(
	path: string,
	cacheService: CacheService,
	apiClient: WorkflowyApiClient,
): Promise<string>
{
	const pathParts = path.split(",").map((s) => s.trim());

	const createdNodes = new Map<string, string>();

	let currentParentId: string | undefined;

	for (const [i, part] of pathParts.entries())
	{
		const subPath = pathParts.slice(0, i + 1);
		const subKey = subPath.join("/");

		if (createdNodes.has(subKey))
		{
			currentParentId = createdNodes.get(subKey);
			continue;
		}

		const cachedNode = cacheService.findNodeByPath(subPath);
		const nodeId = cachedNode?.id ?? (await apiClient.findNodeByPath(subPath))?.id;

		if (nodeId)
		{
			currentParentId = nodeId;
			createdNodes.set(subKey, nodeId);
		}
		else
		{
			// A missing first segment is created at Home (the top level).
			const newNode = await new WorkflowyWriteThroughClient(apiClient, cacheService).createNode(
				{
					parent_id: currentParentId ?? null,
					name: part,
				},
			);

			currentParentId = newNode.id;
			createdNodes.set(subKey, newNode.id);
		}
	}

	if (!currentParentId)
	{
		throw new Error(`Failed to resolve or create path: ${path}`);
	}

	return currentParentId;
}

/**
 * Flags for resolving a parent node.
 * Exactly one of id or path must be provided.
 * The id field accepts UUIDs, system targets (e.g., "inbox"), and "home".
 */
export interface ResolveParentFlags
{
	id?: string;
	path?: string;
}

/**
 * Resolves a parent node ID from id or path.
 *
 * This is the unified resolution function for parent nodes. It handles:
 * - "home" (the top level), returned as `null`
 * - System target keys like "inbox" (detected and returned as-is)
 * - Direct UUIDs (returned as-is)
 * - Paths (resolved via cache then API)
 *
 * @param flags - Object containing exactly one of: id or path
 * @param cacheService - The cache service for local lookup
 * @param apiClient - The API client for remote lookup
 * @returns The resolved parent ID or system target key, or `null` for Home
 * @throws Error if the flag combination is invalid or the node cannot be found
 *
 * @example
 * ```ts
 * // Using system target via --parent-id
 * const parentId = await resolveParent({id: 'inbox'}, cache, api);
 * // parentId === 'inbox'
 *
 * // Using path
 * const parentId = await resolveParent({path: 'Work,Projects'}, cache, api);
 * // parentId === 'uuid-of-projects-node'
 * ```
 */
export async function resolveParent(
	flags: ResolveParentFlags,
	cacheService: CacheService,
	apiClient: WorkflowyApiClient,
): Promise<string | null>
{
	const providedCount = [flags.id, flags.path].filter(Boolean).length;

	if (providedCount === 0)
	{
		throw new Error("One of --parent-id or --parent-path is required");
	}

	if (providedCount > 1)
	{
		throw new Error("Only one of --parent-id or --parent-path can be specified");
	}

	if (flags.id)
	{
		if (flags.id === HOME_TARGET)
		{
			return null;
		}
		if (isSystemTarget(flags.id))
		{
			return flags.id;
		}
		return resolveIdOrShortId(flags.id, cacheService);
	}

	if (flags.path === undefined)
	{
		throw new Error("Either --id or --path is required");
	}
	const nodePath = flags.path.split(",").map((s) => s.trim());
	const cachedNode = cacheService.findNodeByPath(nodePath);
	if (cachedNode)
	{
		return cachedNode.id;
	}

	const apiNode = await apiClient.findNodeByPath(nodePath);
	if (!apiNode)
	{
		throw new Error(`Node not found at path: ${nodePath.join(" > ")}`);
	}
	return apiNode.id;
}

/**
 * Resolves a parent node ID from id or path.
 * Returns undefined if none of the flags are provided.
 *
 * @param flags - Object containing optional id or path
 * @param cacheService - The cache service for local lookup
 * @param apiClient - The API client for remote lookup
 * @returns The resolved parent ID, system target key, `null` for Home, or undefined
 * @throws Error if the node cannot be found
 */
export async function resolveOptionalParent(
	flags: ResolveParentFlags,
	cacheService: CacheService,
	apiClient: WorkflowyApiClient,
): Promise<string | null | undefined>
{
	if (!flags.id && !flags.path)
	{
		return undefined;
	}
	return resolveParent(flags, cacheService, apiClient);
}
