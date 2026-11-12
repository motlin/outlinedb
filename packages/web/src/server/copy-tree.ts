import {NodeTreeReader} from "@outlinedb/shared/cache";
import type {CacheService, NodeTree} from "@outlinedb/shared/cache";
import type {NewTree} from "@outlinedb/shared/internal";

/** The largest subtree a detach copies (upstream's `Detaching mirror subtrees containing more than 2000 items` guard). */
export const MAX_COPY_ITEMS = 2000;

/** The deepest subtree a copy reads; deeper levels (or a cycle) are cut off. */
const COPY_DEPTH = 50;

export interface CopyTreeOptions
{
	/** Whether the top copy starts completed (its own completion; a mirror has none). */
	rootCompleted: boolean;
	/** Whether a descendant that is an original with mirrors becomes a new mirror of itself (upstream `copyProjectTree`). */
	mirrorOriginals: boolean;
	/** Which of the given node ids are originals with live mirrors. */
	originalsWithMirrors: (ids: string[]) => Set<string>;
	newId?: () => string;
}

export type CopiedTree =
	|
	  {
			ok: true;
			tree: NewTree;
			sourceToNew: Map<string, string>;
	  }
	|
	  {
			ok: false;
			count: number;
	  };

function countNodes(node: NodeTree): number
{
	return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function collectIds(node: NodeTree, into: string[]): string[]
{
	into.push(node.id);
	for (const child of node.children ?? [])
	{
		collectIds(child, into);
	}
	return into;
}

/**
 * A deep copy of `sourceId`'s subtree as bulk-create trees, after upstream's `duplicateProjectTree` and
 * `copyProjectTree`: text, note, layout and completion are copied; a descendant mirror stays a mirror of its
 * original; with `mirrorOriginals` a descendant original that has mirrors becomes a new mirror of itself.
 * Every copied node gets an id up front, so callers can carry per-row state (expansion) over to the copy.
 */
export async function copySubtree(
	cache: CacheService,
	sourceId: string,
	options: CopyTreeOptions,
): Promise<CopiedTree | undefined>
{
	const [root] = await new NodeTreeReader(cache).readNodes(
		[sourceId],
		{
			depth: COPY_DEPTH,
		},
	);
	if (root === undefined)
	{
		return undefined;
	}
	const count = countNodes(root);
	if (count > MAX_COPY_ITEMS)
	{
		return {
			ok: false,
			count,
		};
	}
	const newId = options.newId ?? (() => crypto.randomUUID());
	const mirrored = options.mirrorOriginals
		? options.originalsWithMirrors(collectIds(root, []).slice(1))
		: new Set<string>();
	const sourceToNew = new Map<string, string>();
	const mirrorOf = (originalId: string): NewTree => (
	{
		id: newId(),
		name: "",
		metadata:
		{
			mirror:
			{
				originalId,
				isMirrorRoot: true,
			},
		},
	});
	const copy = (node: NodeTree, isRoot: boolean): NewTree =>
	{
		if (!isRoot)
		{
			if (node.mirror.originalNodeId !== null)
			{
				return mirrorOf(node.mirror.originalNodeId);
			}
			if (mirrored.has(node.id))
			{
				return mirrorOf(node.id);
			}
		}
		const id = newId();
		sourceToNew.set(node.id, id);
		const children = (node.children ?? []).map((child) => copy(child, false));
		const completed = isRoot ? options.rootCompleted : node.completedAt !== null;
		return {
			id,
			name: node.name ?? "",
			...(node.note === null || node.note === ""
				? {}
				:
					{
						note: node.note,
					}),
			...(completed
				?
					{
						completed: true,
					}
				: {}),
			...(node.layoutMode === null
				? {}
				:
					{
						metadata:
						{
							layoutMode: node.layoutMode,
						},
					}),
			...(children.length === 0
				? {}
				:
					{
						children,
					}),
		};
	};
	return {
		ok: true,
		tree: copy(root, true),
		sourceToNew,
	};
}
