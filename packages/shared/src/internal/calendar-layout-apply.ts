/**
 * Turning a Calendar Layout plan ({@link planCalendarLayout}) into tree
 * writes the internal API accepts, with the writes that undo them. Pure: the
 * adapter reads fresh state, builds ops from these writes with its clock, and
 * pushes them in one `push_and_poll`.
 */

import type {CalendarLayoutStep} from "./calendar-layout.js";
import {applyMetadataPatches, buildMetadataChanges} from "./metadata-patch.js";
import type {MetadataChange, MetadataPatch} from "./metadata-patch.js";
import type {Location} from "./ops.js";

/** One tree write; serializable, so an undo can be stored and pushed later. */
export type LayoutWrite =
	|
	  {
			op: "edit";
			id: string;
			patches: MetadataPatch[];
			inverse: MetadataPatch[];
	  }
	|
	  {
			op: "create";
			id: string;
			parentId: string;
			index: number;
			name: string;
			metadata: Record<string, unknown>;
	  }
	/** `index` is the slot among the target's children counted before removal, like `moveOp`. */
	|
	  {
			op: "move";
			id: string;
			parentId: string;
			index: number;
			from: Location;
	  }
	|
	  {
			op: "delete";
			id: string;
			from: Location;
	  }
	|
	  {
			op: "undelete";
			id: string;
			parentId: string;
			index: number;
	  };

export interface LayoutWrites
{
	writes: LayoutWrite[];
	/** The writes that put everything back, in push order (the forward writes inverted, last first). */
	undo: LayoutWrite[];
	/** Every parent whose children changed, each after the parent it was created under. */
	touchedParents: string[];
	/** The metadata each edited or created node ends with. */
	metadata: Map<string, Record<string, unknown>>;
}

/** JSON with sorted keys, so equal metadata compares equal whatever its key order. */
function canonical(value: unknown): string
{
	return JSON.stringify(value, (_key, inner: unknown) =>
		typeof inner === "object" && inner !== null && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
			: inner,
	);
}

/** Where a move leaves the node: `index` counts before removal, so a move down its own parent lands one slot higher. */
function landedAt(
	write: Extract<
		LayoutWrite,
		{
			op: "move";
		}
	>,
): Location
{
	const sameParent = write.from.parentId === write.parentId;
	return {
		parentId: write.parentId,
		index: sameParent && write.index > write.from.index ? write.index - 1 : write.index,
	};
}

/** The write that undoes `write`, given the tree as `write` left it. */
function inverseOf(write: LayoutWrite): LayoutWrite
{
	if (write.op === "edit")
	{
		return {
			op: "edit",
			id: write.id,
			patches: write.inverse,
			inverse: write.patches,
		};
	}
	if (write.op === "create")
	{
		return {
			op: "delete",
			id: write.id,
			from:
			{
				parentId: write.parentId,
				index: write.index,
			},
		};
	}
	if (write.op === "delete")
	{
		return {
			op: "undelete",
			id: write.id,
			parentId: write.from.parentId,
			index: write.from.index,
		};
	}
	if (write.op === "undelete")
	{
		return {
			op: "delete",
			id: write.id,
			from:
			{
				parentId: write.parentId,
				index: write.index,
			},
		};
	}
	const from = landedAt(write);
	const back = write.from;
	const index = back.parentId === from.parentId && back.index > from.index ? back.index + 1 : back.index;
	return {
		op: "move",
		id: write.id,
		parentId: back.parentId,
		index,
		from,
	};
}

/**
 * The writes for a layout plan: metadata steps become edits patched against
 * each node's current metadata (`metadataById`, cached by the last import and
 * patched after each accepted edit),
 * and creates, moves and deletes carry the planner's exact slots.
 */
export function calendarLayoutWrites(
	steps: CalendarLayoutStep[],
	metadataById: ReadonlyMap<string, Record<string, unknown>>,
): LayoutWrites
{
	const metadata = new Map<string, Record<string, unknown>>();
	const writes: LayoutWrite[] = [];
	const edit = (id: string, changes: MetadataChange[]): void =>
	{
		const current = metadata.get(id) ?? metadataById.get(id) ?? {};
		const {patches, inverse} = buildMetadataChanges(current, changes);
		const next = applyMetadataPatches(current, patches);
		if (canonical(next) !== canonical(current))
		{
			writes.push(
				{
					op: "edit",
					id,
					patches,
					inverse,
				},
			);
			metadata.set(id, next);
		}
	};
	for (const step of steps)
	{
		switch (step.op)
		{
			case "set-calendar":
			{
				edit(step.id, [
					{
						path: ["calendar"],
						value: step.calendar ?? undefined,
					},
				]);
				break;
			}
			case "set-levels":
			{
				edit(step.id, [
					{
						path: ["calendar", "levels"],
						value: step.levels,
					},
				]);
				break;
			}
			case "create":
			{
				const {id, parentId, index, name} = step;
				writes.push(
					{
						op: "create",
						id,
						parentId,
						index,
						name,
						metadata: step.metadata,
					},
				);
				metadata.set(id, step.metadata);
				break;
			}
			case "move":
			{
				writes.push(
					{
						op: "move",
						id: step.id,
						parentId: step.parentId,
						index: step.index,
						from: step.from,
					},
				);
				break;
			}
			case "delete":
			{
				writes.push(
					{
						op: "delete",
						id: step.id,
						from: step.from,
					},
				);
				break;
			}
		}
	}
	return {
		writes,
		undo: writes.map(inverseOf).toReversed(),
		touchedParents: layoutWriteParents(writes),
		metadata,
	};
}

/** The parents a list of writes changes, in first-touch order, leaving out those the writes delete. */
export function layoutWriteParents(writes: LayoutWrite[]): string[]
{
	const touched = new Set<string>();
	const deleted = new Set<string>();
	for (const write of writes)
	{
		if (write.op === "create" || write.op === "undelete")
		{
			touched.add(write.parentId);
			deleted.delete(write.id);
		}
		else if (write.op === "move")
		{
			touched.add(write.from.parentId).add(write.parentId);
		}
		else if (write.op === "delete")
		{
			touched.add(write.from.parentId);
			deleted.add(write.id);
		}
	}
	return [...touched].filter((id) => !deleted.has(id));
}
