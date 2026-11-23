import {NodeTreeReader} from "@outlinedb/shared/cache";
import type {CacheService, NodeTree} from "@outlinedb/shared/cache";
import type {NewTree} from "@outlinedb/shared/internal";

/** The largest subtree a detach copies (upstream's `Detaching mirror subtrees containing more than 2000 items` guard). */
export const MAX_COPY_ITEMS = 2000;

/** The deepest level below the copied node that a copy makes; a deeper subtree is refused, never cut off. */
export const MAX_COPY_DEPTH = 50;

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
			reason: "tooMany";
			count: number;
	  }
	|
	  {
			ok: false;
			reason: "tooDeep";
	  };

/** The ids of the nodes below `node` that the copy reaches, not descending into mirrors (their children are their original's). */
function collectDescendantIds(node: NodeTree, into: string[]): string[]
{
	for (const child of node.children ?? [])
	{
		into.push(child.id);
		if (child.mirror.originalNodeId === null)
		{
			collectDescendantIds(child, into);
		}
	}
	return into;
}

/**
 * How many nodes the copy makes, and whether any lands deeper than {@link MAX_COPY_DEPTH}. A node that the copy
 * turns into a bare mirror counts once, without the subtree the reader resolved under it.
 */
function measure(
	root: NodeTree,
	isBareMirror: (node: NodeTree) => boolean,
):
{
	count: number;
	tooDeep: boolean;
}
{
	let count = 0;
	let tooDeep = false;
	const visit = (node: NodeTree, level: number): void =>
	{
		count += 1;
		if (level > MAX_COPY_DEPTH)
		{
			tooDeep = true;
			return;
		}
		if (level > 0 && isBareMirror(node))
		{
			return;
		}
		for (const child of node.children ?? [])
		{
			visit(child, level + 1);
		}
	};
	visit(root, 0);
	return {
		count,
		tooDeep,
	};
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
	// One level past the limit, so a subtree that goes deeper shows up instead of being silently cut off.
	const [root] = await new NodeTreeReader(cache).readNodes(
		[sourceId],
		{
			depth: MAX_COPY_DEPTH + 1,
		},
	);
	if (root === undefined)
	{
		return undefined;
	}
	const mirrored = options.mirrorOriginals
		? options.originalsWithMirrors(collectDescendantIds(root, []))
		: new Set<string>();
	const {count, tooDeep} = measure(root, (node) => node.mirror.originalNodeId !== null || mirrored.has(node.id));
	if (count > MAX_COPY_ITEMS)
	{
		return {
			ok: false,
			reason: "tooMany",
			count,
		};
	}
	if (tooDeep)
	{
		return {
			ok: false,
			reason: "tooDeep",
		};
	}
	const newId = options.newId ?? (() => crypto.randomUUID());
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
