/**
 * Undoing a Calendar Layout from temporal history: the writes that turn the
 * subtree under the calendar root as it is now back into the subtree as it
 * was just before the layout. Pure: the adapter reads both states from the
 * cache (one as of the layout's system time) and pushes the writes.
 */

import type {LayoutWrite} from "./calendar-layout-apply.js";
import {buildMetadataChanges} from "./metadata-patch.js";
import type {MetadataChange} from "./metadata-patch.js";

type Metadata = Record<string, unknown>;

/** A subtree at one system time: every node's ordered children (leaves map to `[]`) and its kept metadata. */
export interface SubtreeState
{
	children: ReadonlyMap<string, readonly string[]>;
	metadata: ReadonlyMap<string, Metadata>;
}

function isObject(value: unknown): value is Metadata
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean
{
	if (isObject(a) && isObject(b))
	{
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].every((key) => sameValue(a[key], b[key]));
	}
	return a === b;
}

/** The changes that turn `current` into `target`, recursing into objects both sides hold. */
function metadataChanges(current: Metadata, target: Metadata, path: string[] = []): MetadataChange[]
{
	const keys = [...new Set([...Object.keys(current), ...Object.keys(target)])];
	return keys.flatMap((key): MetadataChange[] =>
	{
		const from = current[key];
		const to = target[key];
		if (sameValue(from, to))
		{
			return [];
		}
		if (isObject(from) && isObject(to))
		{
			return metadataChanges(from, to, [...path, key]);
		}
		return [
			{
				path: [...path, key],
				value: to,
			},
		];
	});
}

function parentsOf(children: ReadonlyMap<string, readonly string[]>): Map<string, string>
{
	const parents = new Map<string, string>();
	for (const [parent, kids] of children)
	{
		for (const kid of kids)
		{
			parents.set(kid, parent);
		}
	}
	return parents;
}

function isLevelNode(metadata: Metadata | undefined): boolean
{
	const calendar = metadata?.calendar;
	return isObject(calendar) && calendar.level !== undefined;
}

/**
 * The writes, in push order, that put the subtree under `rootId` back the way
 * `before` had it, starting from `now`. Each parent of `before` is visited top
 * down: its children are moved (or, when gone from the cache, undeleted) into
 * their old slots, so a node added since stays, after the restored siblings.
 * A node now outside the subtree but still cached (`isCachedElsewhere`) was
 * moved out since, and is left alone. Level nodes the layout created are then
 * deleted, deepest first; one still holding a node added since throws. Edits
 * put back the metadata of every node both states hold.
 */
export function calendarLayoutUndoWrites(
	rootId: string,
	before: SubtreeState,
	now: SubtreeState,
	isCachedElsewhere: (id: string) => boolean,
): LayoutWrite[]
{
	const writes: LayoutWrite[] = [];
	const lists = new Map([...now.children].map(([parent, kids]) => [parent, [...kids]]));
	const parents = parentsOf(now.children);
	const listOf = (parent: string): string[] =>
	{
		let list = lists.get(parent);
		if (list === undefined)
		{
			list = [];
			lists.set(parent, list);
		}
		return list;
	};

	const queue = [rootId];
	for (let parent = queue.shift(); parent !== undefined; parent = queue.shift())
	{
		let slot = 0;
		for (const child of before.children.get(parent) ?? [])
		{
			const from = parents.get(child);
			if (from === undefined && isCachedElsewhere(child))
			{
				continue;
			}
			const target = listOf(parent);
			if (from === undefined)
			{
				writes.push(
					{
						op: "undelete",
						id: child,
						parentId: parent,
						index: slot,
					},
				);
			}
			else
			{
				const source = listOf(from);
				const index = source.indexOf(child);
				if (from !== parent || index !== slot)
				{
					writes.push(
						{
							op: "move",
							id: child,
							parentId: parent,
							index: slot,
							from:
							{
								parentId: from,
								index,
							},
						},
					);
				}
				source.splice(index, 1);
			}
			target.splice(slot, 0, child);
			parents.set(child, parent);
			slot += 1;
			queue.push(child);
		}
	}

	const beforeIds = new Set([rootId, ...parentsOf(before.children).keys()]);
	let created = [...parents.keys()].filter((id) => !beforeIds.has(id) && isLevelNode(now.metadata.get(id)));
	while (created.length > 0)
	{
		const empty = created.filter((id) => listOf(id).length === 0);
		if (empty.length === 0)
		{
			throw new Error(`calendar layout: cannot undo, ${created[0]} still holds nodes added since the layout`);
		}
		for (const id of empty)
		{
			const parent = parents.get(id) ?? rootId;
			const siblings = listOf(parent);
			const index = siblings.indexOf(id);
			writes.push(
				{
					op: "delete",
					id,
					from:
					{
						parentId: parent,
						index,
					},
				},
			);
			siblings.splice(index, 1);
			parents.delete(id);
		}
		created = created.filter((id) => !empty.includes(id));
	}

	for (const id of beforeIds)
	{
		if (now.children.has(id))
		{
			const current = now.metadata.get(id) ?? {};
			const changes = metadataChanges(current, before.metadata.get(id) ?? {});
			if (changes.length > 0)
			{
				writes.push(
					{
						op: "edit",
						id,
						...buildMetadataChanges(current, changes),
					},
				);
			}
		}
	}
	return writes;
}
