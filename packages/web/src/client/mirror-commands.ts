// Creating mirrors from the web app: Mirror (copy then paste), Mirror To..., Mirror Here... (upstream `Mi1`, `$K`,
// `yi1` in the mirrors plugin). The server write is `POST /api/v1/nodes/mirror`.
import type {MoveToToast, MoveToTarget, LoadedMoveTarget} from "./move-to.js";
import {defaultIndexIn} from "./tree-ops.js";

const MIRROR_TOAST_TIMEOUT = 5000;

/** What `POST /api/v1/nodes/mirror` takes. */
export interface MirrorRequest
{
	item_ids: string[];
	parent_id: string | null;
	index: number;
}

/**
 * Upstream's clipboard payload: one `<div data-wf-mirror="<original id>">&nbsp;</div>` per item. Upstream builds it by
 * concatenation from `undefined`, so its payload starts with the literal word `undefined`; this one does not.
 */
export function mirrorClipboardHtml(originalIds: readonly string[]): string
{
	return originalIds.map((id) => `<div data-wf-mirror="${id}">&nbsp;</div>`).join("");
}

/** The original ids named by `[data-wf-mirror]` elements in pasted html, in order. */
export function parseMirrorPaste(html: string): string[]
{
	return [...html.matchAll(/data-wf-mirror="([^"]*)"/gu)].map((match) => match[1] ?? "");
}

export const MIRROR_COPIED_TOAST =
{
	text: "Mirror(s) copied. Paste it where you want it to go.",
	timeout: 30_000,
	dismissOn: ["copy", "paste"],
} as const;

export function mirrorToastText(kind: "to" | "here" | "cant-here", name: string): string
{
	if (kind === "to")
	{
		return `mirrored to '${name}'`;
	}
	return kind === "here" ? `mirrored '${name}' here` : "Can't mirror the selected bullet here";
}

/** Mirror To...: the items go into the target at its default slot, like Move To (with no `canMoveUnder` check). */
export function planMirrorTo({
	items,
	target,
	childCount,
}: {
	items: readonly string[];
	target: Pick<MoveToTarget, "id" | "defaultToBottom">;
	childCount: number;
}): MirrorRequest
{
	return {
		item_ids: [...items],
		parent_id: target.id,
		index: defaultIndexIn(target, childCount),
	};
}

/** Mirror Here...: the picked item is mirrored right after the row under its parent, or at the top of the zoom root. */
export function planMirrorHere({
	picked,
	itemId,
	parentId,
	siblingIndex,
	isZoomRoot,
}: {
	picked: string;
	itemId: string;
	parentId: string | null;
	siblingIndex: number;
	isZoomRoot: boolean;
}): MirrorRequest
{
	return isZoomRoot
		?
			{
				item_ids: [picked],
				parent_id: itemId,
				index: 0,
			}
		:
			{
				item_ids: [picked],
				parent_id: parentId,
				index: siblingIndex + 1,
			};
}

/** Upstream deletes the Mirror Here trigger row once the mirror lands in its place, if it is blank. */
export function shouldDeleteMirrorTrigger(row: {
	name: string;
	note: string;
	childCount: number;
	isZoomRoot: boolean;
	readOnly: boolean;
}): boolean
{
	return row.name === "" && row.note === "" && row.childCount === 0 && !row.isZoomRoot && !row.readOnly;
}

interface MirrorToDeps
{
	/** Opens the location picker; the chosen location (or the one its create-and-pick just made). */
	pick: () => Promise<
		|
		  {
				id: string;
		  }
		|
		  {
				createdId: string;
		  }
		| undefined
	>;
	loadTarget: (id: string) => Promise<LoadedMoveTarget>;
	/** Creates the mirrors; resolves to how many were made. */
	mirrorNodes: (request: MirrorRequest) => Promise<number>;
	showToast: (toast: MoveToToast) => void;
	view: (targetId: string) => void;
	undo: () => void;
}

/** Mirror To...: pick a location, mirror the items there, toast `mirrored to '<name>'` with View and Undo. */
export async function executeMirrorTo({
	items,
	pick,
	loadTarget,
	mirrorNodes,
	showToast,
	view,
	undo,
}: MirrorToDeps &
{
	items: readonly string[];
}): Promise<boolean>
{
	const picked = await pick();
	if (picked === undefined)
	{
		return false;
	}
	const {target, childCount} = await loadTarget("id" in picked ? picked.id : picked.createdId);
	const created = await mirrorNodes(
		planMirrorTo(
			{
				items,
				target,
				childCount,
			},
		),
	);
	if (created === 0)
	{
		return false;
	}
	showToast(
		{
			text: mirrorToastText("to", target.name),
			timeout: MIRROR_TOAST_TIMEOUT,
			actions: [
				{
					label: "View",
					shortcut: "shift+return",
					run: () =>
					{
						view(target.id);
					},
				},
				{
					label: "Undo",
					run: undo,
				},
			],
		},
	);
	return true;
}

/**
 * Mirror Here...: pick the item to mirror, put its mirror at `plan`, delete the blank trigger row, and toast
 * `mirrored '<name>' here` (5000ms, Undo) or the failure when nothing was made.
 */
export async function executeMirrorHere({
	pick,
	loadName,
	plan,
	mirrorNodes,
	deleteTrigger,
	showToast,
	undo,
}: {
	pick: () => Promise<
		|
		  {
				id: string;
		  }
		|
		  {
				createdId: string;
		  }
		| undefined
	>;
	loadName: (id: string) => Promise<string>;
	plan: (picked: string) => MirrorRequest;
	mirrorNodes: (request: MirrorRequest) => Promise<number>;
	/** Deletes the trigger row when it is blank; a no-op otherwise. */
	deleteTrigger: () => void;
	showToast: (toast: MoveToToast) => void;
	undo: () => void;
}): Promise<boolean>
{
	const picked = await pick();
	if (picked === undefined)
	{
		return false;
	}
	const id = "id" in picked ? picked.id : picked.createdId;
	const created = await mirrorNodes(plan(id)).catch(() => 0);
	if (created === 0)
	{
		showToast(
			{
				text: mirrorToastText("cant-here", ""),
				timeout: MIRROR_TOAST_TIMEOUT,
				actions: [],
				type: "failure",
			},
		);
		return false;
	}
	deleteTrigger();
	showToast(
		{
			text: mirrorToastText("here", await loadName(id)),
			timeout: MIRROR_TOAST_TIMEOUT,
			actions: [
				{
					label: "Undo",
					run: undo,
				},
			],
		},
	);
	return true;
}

/** The original each item mirrors: the original of a mirror, else the item itself. */
export function mirrorSourceIds(
	items: readonly string[],
	lookup: (id: string) =>
		|
		  {
				isMirror?: boolean;
				originalNodeId?: string | null;
		  }
		| undefined,
): string[]
{
	return items.map((id) =>
	{
		const node = lookup(id);
		return node?.isMirror === true && node.originalNodeId ? node.originalNodeId : id;
	});
}
