import type {TreeDataItem} from "../api/workflowy-internal-client.js";
import type {WorkflowyNode} from "../types/index.js";

/**
 * The export node a `/get_tree_data/` item stands for, so the export import path applies it. Its timestamps are
 * seconds since the account joined (`dateJoinedSec`); the export's are Unix seconds. An item with no creation time
 * counts as created when the account joined.
 */
export function treeDataNode(item: TreeDataItem, dateJoinedSec: number): WorkflowyNode
{
	const layoutMode = item.metadata?.layoutMode;
	const completed = item.cp !== undefined && item.cp !== null;
	return {
		id: item.id,
		name: item.nm ?? "",
		note: item.no === undefined || item.no === "" ? null : item.no,
		parent_id: item.prnt ?? null,
		priority: item.pr ?? 0,
		completed,
		...(typeof layoutMode === "string"
			?
				{
					data:
					{
						layoutMode,
					},
				}
			: {}),
		createdAt: dateJoinedSec + (item.ct ?? 0),
		modifiedAt: item.lm === undefined ? null : dateJoinedSec + item.lm,
		completedAt: completed ? dateJoinedSec + (item.cp ?? 0) : null,
	};
}
