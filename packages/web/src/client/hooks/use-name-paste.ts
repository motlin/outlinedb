import {useCallback} from "react";
import type {ClipboardEvent as ReactClipboardEvent, RefObject} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {showAlert} from "../alert.js";
import {placeCaretAtTextOffset, selectionTextOffsets} from "../caret-dom.js";
import {resolveLayoutMode} from "../components/layout-mode.js";
import type {DateSettings} from "../date-settings.js";
import {renderEditorHtml, serializeEditorHtml} from "../editor-html.js";
import type {MentionAccount} from "../mention-pills.js";
import {readChildren, readNode} from "../node-cache.js";
import
{
	buildItemCopyLines,
	buildPasteLines,
	planItemCopy,
	planMultilineSplice,
	planPasteApply,
} from "../paste/apply.js";
import type {PasteTree} from "../paste/apply.js";
import {createTrees} from "../paste/create-trees.js";
import {plainLength, splitHtml} from "../rich-text.js";
import {activePaneView, outlineActions} from "../stores/outline.js";
import {sortByPriority} from "../tree-position.js";
import {captureOutlineView, holdUndoSlot, runInUndoBatch} from "../undo-batch.js";
import {usePlainPasteKey} from "./use-plain-paste-key.js";
import {mirrorNodeAt, restoreNode, syncNodeChanges, toggleComplete, useDeleteNode, useUpdateNode} from "./use-nodes.js";
import {cutEntryFor, forgetCut} from "../cut-registry.js";
import
{
	CUT_PASTE_WARNING,
	copyTreeFromCache,
	mirrorOriginalFromCache,
	pasteSteps,
	planItemPaste,
	resolveShortId,
	stepsRunnable,
} from "../paste/items.js";
import type {ItemPasteStep} from "../paste/items.js";
import {applyLinkPaste, cachedLinkTargetName, planLinkPaste} from "../link-paste.js";
import {RequestStatusError} from "../request-error.js";
import {hideBanner, showBanner} from "../stores/banner.js";

interface NamePasteOptions
{
	nodeId: string;
	parentId: string | null;
	contentRef: RefObject<HTMLSpanElement | null>;
	dateSettings: DateSettings;
	account: MentionAccount;
	/** Reset the name saver to text already sent to the server. */
	resetSaved: (name: string) => void;
	/** The editor's text changed in place; schedule its save. */
	changed: () => void;
}

interface ItemPasteTarget
{
	queryClient: QueryClient;
	parentId: string | null;
	baseIndex: number;
}

/**
 * Run the steps of a paste of copied rows from `baseIndex` under `parentId` (see `pasteSteps`). Rows a refused restore
 * leaves behind are pasted as copies of the html's rows (`copyTrees`).
 */
async function pasteItemSteps(
	steps: readonly ItemPasteStep[],
	{queryClient, parentId, baseIndex}: ItemPasteTarget,
	copyTrees: readonly PasteTree[],
): Promise<Awaited<ReturnType<typeof pasteSteps>>>
{
	const createOne = async (tree: PasteTree | undefined, at: number): Promise<string | undefined> =>
		tree === undefined
			? undefined
			: (
					await createTrees(
						queryClient,
						{
							parentId,
							index: at,
							trees: [tree],
						},
					)
				)[0];
	const result = await pasteSteps(
		steps,
		baseIndex,
		{
			async restore(step, at)
			{
				const slot = holdUndoSlot();
				try
				{
					await restoreNode(
						step.id,
						{
							parent_id: parentId,
							index: at,
						},
					);
				}
				catch (error)
				{
					slot.settle([]);
					throw error;
				}
				slot.settle([
					{
						kind: "undelete",
						nodeId: step.id,
						parentId,
						index: at,
					},
				]);
				forgetCut(step.shortId);
				hideBanner();
			},
			mirror: async (originalId, at) => mirrorNodeAt(queryClient, originalId, parentId, at),
			copyFromCache: async (id, at) => createOne(copyTreeFromCache(queryClient, id), at),
			fallbackCopy: async (stepIndex, at) => createOne(copyTrees[stepIndex], at),
		},
	);
	await syncNodeChanges(queryClient);
	return result;
}

function lastTree(trees: readonly PasteTree[]): PasteTree | undefined
{
	return trees.at(-1);
}

/** Upstream's `editor:paste` middlewares and `WF.GuiPaste.intoContent` for the name editor. */
export function useNamePaste({
	nodeId,
	parentId,
	contentRef,
	dateSettings,
	account,
	resetSaved,
	changed,
}: NamePasteOptions)
{
	const queryClient = useQueryClient();
	const updateNode = useUpdateNode();
	const deleteNode = useDeleteNode();
	const plainKey = usePlainPasteKey();

	return useCallback(
		(event: ReactClipboardEvent<HTMLElement>) =>
		{
			const content = contentRef.current;
			const data = event.clipboardData;
			if (content === null)
			{
				return;
			}
			const text = data.getData("text/plain");
			const html = data.getData("text/html");
			// Image files belong to uploads: leave the native paste.
			if (data.files.length > 0 && text === "")
			{
				return;
			}
			const selection = globalThis.getSelection();
			const anchorElement =
				selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
			const showName = (name: string, caret: number): void =>
			{
				content.innerHTML = renderEditorHtml(name, dateSettings, account);
				placeCaretAtTextOffset(content, caret);
			};
			const stored = serializeEditorHtml(content.innerHTML);
			const offsets = selectionTextOffsets(content);
			const {before, after} = splitHtml(stored, offsets.start, offsets.end);
			const node = readNode(queryClient, nodeId);
			const layoutMode = node?.data.layoutMode;

			// Inside a code span the trimmed text goes in as code.
			if (anchorElement?.closest("code") && content.contains(anchorElement))
			{
				event.preventDefault();
				const splice = planMultilineSplice(
					{
						before,
						after,
						text: text.trim(),
					},
				);
				showName(splice.html, splice.caret);
				changed();
				return;
			}
			// A code-block row keeps every line in the one row; html is ignored.
			// A quote-block row is multiline too: its text goes in place with newlines kept.
			if (
				layoutMode === "code-block" ||
				(layoutMode !== undefined && resolveLayoutMode(layoutMode).projectClasses.includes("multiline"))
			)
			{
				event.preventDefault();
				const splice = planMultilineSplice(
					{
						before,
						after,
						text: layoutMode === "code-block" ? text.trim() : text,
					},
				);
				showName(splice.html, splice.caret);
				changed();
				return;
			}
			const linkPlan = plainKey.current
				? null
				: planLinkPaste(
						{
							clipboardText: text,
							selectionText: selection?.toString() ?? "",
							collapsed: offsets.start === offsets.end,
							inCode: false,
							resolveTargetName: (href) => cachedLinkTargetName(queryClient, href),
						},
					);
			if (linkPlan !== null)
			{
				event.preventDefault();
				const linked = applyLinkPaste(stored, offsets, linkPlan);
				showName(linked.html, linked.caret);
				changed();
				return;
			}
			event.preventDefault();

			const view = activePaneView();
			const siblings = sortByPriority(readChildren(queryClient, parentId) ?? []);
			const rowIndex = Math.max(
				siblings.findIndex((sibling) => sibling.id === nodeId),
				0,
			);
			const children = readChildren(queryClient, nodeId) ?? [];
			const rowKind =
				nodeId === view.zoomedNodeId
					? "zoomRoot"
					: children.length > 0 || (node?.note ?? "") !== ""
						? "branch"
						: "leaf";
			const {resumeEditing, expand} = outlineActions();

			const itemSteps = plainKey.current
				? null
				: planItemPaste(
						html,
						{
							cutId: (shortId) => cutEntryFor(shortId)?.id,
							resolve: (shortId) => resolveShortId(queryClient, shortId),
							mirrorOriginal: (id) => mirrorOriginalFromCache(queryClient, id),
						},
					);
			if (itemSteps !== null && "alert" in itemSteps)
			{
				showAlert(itemSteps.alert, "Error");
				return;
			}
			const copied = plainKey.current ? null : buildItemCopyLines(html);
			const copiedTrees =
				copied === null
					? []
					: planItemCopy(
							{
								lines: copied,
								rowEmpty: false,
								rowIndex: 0,
								rowOpen: false,
							},
						).trees;
			const pasteCopiedLines = (): void =>
			{
				if (copied === null)
				{
					return;
				}
				const plan = planItemCopy(
					{
						lines: copied,
						rowEmpty: stored.trim() === "" && offsets.start === 0 && offsets.end === 0,
						rowIndex,
						rowOpen: view.expandedIds.has(nodeId) && children.length > 0,
					},
				);
				void runInUndoBatch(captureOutlineView, async () =>
				{
					const request =
						plan.placement.kind === "index"
							?
								{
									parentId,
									index: plan.placement.index,
								}
							: plan.placement.kind === "firstChild"
								?
									{
										parentId: nodeId,
										index: 0,
									}
								:
									{
										parentId,
										afterId: nodeId,
									};
					const ids = await createTrees(
						queryClient,
						{
							...request,
							trees: plan.trees,
						},
					);
					if (plan.deleteCurrent)
					{
						deleteNode.mutate(nodeId);
					}
					else if (plan.placement.kind === "firstChild")
					{
						expand(nodeId);
					}
					const last = ids.at(-1);
					const tree = lastTree(plan.trees);
					if (last !== undefined && tree !== undefined)
					{
						resumeEditing(last, plainLength(tree.name));
					}
				}).catch(() => {});
			};
			if (itemSteps !== null && stepsRunnable(itemSteps))
			{
				const placementPlan = planItemCopy(
					{
						lines: [],
						rowEmpty: stored.trim() === "" && offsets.start === 0 && offsets.end === 0,
						rowIndex,
						rowOpen: view.expandedIds.has(nodeId) && children.length > 0,
					},
				);
				void runInUndoBatch(captureOutlineView, async () =>
				{
					const placed = await pasteItemSteps(
						itemSteps,
						{
							queryClient,
							parentId: placementPlan.placement.kind === "firstChild" ? nodeId : parentId,
							baseIndex:
								placementPlan.placement.kind === "index"
									? placementPlan.placement.index
									: placementPlan.placement.kind === "firstChild"
										? 0
										: rowIndex + 1,
						},
						copiedTrees,
					);
					if (placed.unmovable)
					{
						showBanner(
							CUT_PASTE_WARNING,
							{
								kind: "warn",
							},
						);
						pasteCopiedLines();
						return;
					}
					if (placed.fellBack)
					{
						showBanner(
							CUT_PASTE_WARNING,
							{
								kind: "warn",
							},
						);
					}
					if (placementPlan.deleteCurrent)
					{
						deleteNode.mutate(nodeId);
					}
					else if (placementPlan.placement.kind === "firstChild")
					{
						expand(nodeId);
					}
					if (placed.lastId !== null)
					{
						resumeEditing(placed.lastId, Number.MAX_SAFE_INTEGER);
					}
				}).catch(() => {});
				return;
			}
			if (copied !== null)
			{
				pasteCopiedLines();
				return;
			}

			const lines = buildPasteLines(
				{
					text,
					html,
					plain: plainKey.current,
				},
			);
			const plan = planPasteApply(
				{
					before,
					after,
					lines,
					rowKind,
				},
			);
			if ("alert" in plan)
			{
				showAlert(plan.alert, "Error");
				return;
			}
			void runInUndoBatch(captureOutlineView, async () =>
			{
				if (plan.currentName !== null)
				{
					const name = plan.currentName;
					showName(
						name,
						plan.caret.row === "current" && plan.caret.offset !== "end"
							? plan.caret.offset
							: plainLength(name),
					);
					resetSaved(name);
					updateNode.mutate(
						{
							nodeId,
							name,
							...(plan.current?.note === undefined
								? {}
								:
									{
										note: plan.current.note,
									}),
							...(plan.current?.layoutMode === undefined
								? {}
								:
									{
										layoutMode: plan.current.layoutMode,
									}),
							...(plan.current?.numberedStart === undefined
								? {}
								:
									{
										numberedStart: plan.current.numberedStart,
									}),
						},
					);
					if (plan.current?.complete === true)
					{
						toggleComplete(
							queryClient,
							{
								nodeId,
								isCurrentlyCompleted: false,
							},
						);
					}
				}
				let created:
					|
					  {
							id: string;
							tree: PasteTree;
					  }
					| undefined;
				if (plan.childTrees.length > 0)
				{
					const ids = await createTrees(
						queryClient,
						{
							parentId: nodeId,
							index: 0,
							trees: plan.childTrees,
						},
					);
					expand(nodeId);
					const last = ids.at(-1);
					const tree = lastTree(plan.childTrees);
					created =
						last !== undefined && tree !== undefined
							?
								{
									id: last,
									tree,
								}
							: created;
				}
				if (plan.siblingTrees.length > 0)
				{
					const ids = await createTrees(
						queryClient,
						{
							parentId,
							afterId: nodeId,
							trees: plan.siblingTrees,
						},
					);
					const last = ids.at(-1);
					const tree = lastTree(plan.siblingTrees);
					created =
						last !== undefined && tree !== undefined
							?
								{
									id: last,
									tree,
								}
							: created;
				}
				if (plan.caret.row === "lastCreated" && created !== undefined)
				{
					resumeEditing(
						created.id,
						plan.caret.offset === "end" ? plainLength(created.tree.name) : plan.caret.offset,
					);
				}
			}).catch(() => {});
		},
		[
			account,
			changed,
			contentRef,
			dateSettings,
			deleteNode,
			nodeId,
			parentId,
			plainKey,
			queryClient,
			resetSaved,
			updateNode,
		],
	);
}
