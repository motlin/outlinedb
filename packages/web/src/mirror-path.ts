/**
 * Cycle detection for mirrors rendered inside their own original, after upstream's virtual mirror items. A row met
 * inside a mirror is an instance of the original's row: its identity is the mirror root plus a path that grows by
 * the first four characters of each row's id (`Fp.isCyclical`, `mirrorPath`). A mirror whose path repeats one chunk
 * three times is cyclical: it renders collapsed and no walker descends into it.
 */
import {virtualId} from "@outlinedb/shared/workflowy";

const MIRROR_CHUNK = 4;
const CYCLICAL_REPEATS = 3;

/** Where a row sits inside a mirror: the outermost mirror root and the chunks of the rows between. */
export interface MirrorInstance
{
	rootId: string;
	path: string;
}

interface MirrorLike
{
	id?: string;
	isMirror?: boolean;
	originalNodeId?: string | null;
}

function isMirrorRow(node: MirrorLike): boolean
{
	return node.isMirror === true || (node.originalNodeId !== undefined && node.originalNodeId !== null);
}

/** The instance its children render in: a mirror outside any mirror starts one, a row inside one extends it. */
export function childInstance(
	parent: MirrorLike &
	{
		id: string;
	},
	instance: MirrorInstance | null,
): MirrorInstance | null
{
	const chunk = parent.id.slice(0, MIRROR_CHUNK);
	if (instance !== null)
	{
		return {
			rootId: instance.rootId,
			path: instance.path + chunk,
		};
	}
	return isMirrorRow(parent)
		?
			{
				rootId: parent.id,
				path: chunk,
			}
		: null;
}

/** Whether `node`, rendered in `instance`, is a mirror whose path repeats one chunk `CYCLICAL_REPEATS` times. */
export function isCyclical(node: MirrorLike, instance: MirrorInstance | null): boolean
{
	if (instance === null || !isMirrorRow(node))
	{
		return false;
	}
	const counts = new Map<string, number>();
	for (let i = 0; i + MIRROR_CHUNK <= instance.path.length; i += MIRROR_CHUNK)
	{
		const chunk = instance.path.slice(i, i + MIRROR_CHUNK);
		const count = (counts.get(chunk) ?? 0) + 1;
		if (count >= CYCLICAL_REPEATS)
		{
			return true;
		}
		counts.set(chunk, count);
	}
	return false;
}

/**
 * The key a row's expansion is stored under: its plain id outside any mirror, and per-instance inside one
 * (`virtual_<id>_<mirror root>_<path>`), so expanding a row inside a mirror leaves the original and every other
 * mirror alone (upstream `projectIdIsExpanded("virtual_…")`).
 */
export function expansionId(nodeId: string, instance: MirrorInstance | null): string
{
	return instance === null
		? nodeId
		: virtualId(
				{
					childId: nodeId,
					mirrorRootId: instance.rootId,
					path: instance.path,
				},
			);
}

/** The key of a parent's children within an instance: the plain id outside any mirror. */
export function instanceKey(parentId: string | null, instance: MirrorInstance | null): string | null
{
	return instance === null || parentId === null ? parentId : `${parentId}@${instance.rootId}_${instance.path}`;
}
