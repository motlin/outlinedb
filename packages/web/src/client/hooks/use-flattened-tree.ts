import type {NodeResponse} from "../../node-types.js";
import {isPotentiallyVisible, rowHasChildren} from "../tree-ops.js";
import type {SearchFilter} from "../search-filter.js";
import type {MirrorInstance} from "../../mirror-path.js";
import {childInstance, expansionId, isCyclical} from "../../mirror-path.js";
import {isSearchExpanded, searchShowsCompleted, searchShowsNode} from "../search-filter.js";

/**
 * A flattened node includes the original node data plus its depth in the tree.
 * This allows us to render a flat list with proper indentation.
 */
interface FlattenedNode
{
	node: NodeResponse;
	depth: number;
	isExpanded: boolean;
	hasChildren: boolean;
}

/**
 * Recursively flattens the tree structure into an array for virtualization.
 * Only includes nodes that are visible (i.e., all ancestors are expanded).
 * During a search, only rows the search shows are kept and expansion comes from the search, not `expandedIds`.
 */
export function flattenTree(
	nodes: NodeResponse[] | undefined,
	expandedIds: Set<string>,
	showCompleted: boolean,
	depth: number,
	childrenMap: Map<string, NodeResponse[]>,
	animating: ReadonlySet<string>,
	search: SearchFilter | null = null,
	instance: MirrorInstance | null = null,
): FlattenedNode[]
{
	if (!nodes || nodes.length === 0)
	{
		return [];
	}

	const showsCompleted = searchShowsCompleted(showCompleted, search);
	const visibleNodes = nodes.filter(
		(node) =>
			isPotentiallyVisible(node, showsCompleted, animating) && (search === null || searchShowsNode(node, search)),
	);

	const result: FlattenedNode[] = [];

	for (const node of visibleNodes)
	{
		const isExpanded =
			search === null ? expandedIds.has(expansionId(node.id, instance)) : isSearchExpanded(node.id, search);
		const children = childrenMap.get(node.id);
		// Use the server-provided child flags when available, otherwise fall back to checking fetched children
		const hasChildren =
			node.hasChildren === undefined
				? children === undefined || children.length > 0
				: rowHasChildren(node, showCompleted);

		result.push(
			{
				node,
				depth,
				isExpanded,
				hasChildren,
			},
		);

		// Only recurse into expanded nodes that have fetched children
		if (isExpanded && children && children.length > 0 && (search === null || !isCyclical(node, instance)))
		{
			const childFlattened = flattenTree(
				children,
				expandedIds,
				showCompleted,
				depth + 1,
				childrenMap,
				animating,
				search,
				childInstance(node, instance),
			);
			result.push(...childFlattened);
		}
	}

	return result;
}
