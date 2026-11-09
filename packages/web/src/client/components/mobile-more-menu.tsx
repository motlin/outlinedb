import {useQueryClient} from "@tanstack/react-query";
import {useState} from "react";
import {HOME_TARGET} from "@outlinedb/shared/types";
import {openMenuExport} from "../export-entry.js";
import {useExpandAll, useDeleteNode} from "../hooks/use-nodes.js";
import {activeCommandRegistry} from "../hooks/use-global-keymap.js";
import {pickerItemTypes} from "../item-type-select.js";
import {moreMenuRows} from "../mobile-more-menu-model.js";
import type {MoreMenuRow} from "../mobile-more-menu-model.js";
import {useNodeNavigation} from "../navigation.js";
import {readNode} from "../node-cache.js";
import type {NodeListResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {Sheet} from "../stores/sheet.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {useUndoStore} from "../undo-history.js";
import type {FaIconKey} from "./fa-icons.js";
import {FaIcon} from "./fa-icons.js";
import {useHeaderActions} from "./header-actions.js";
import {Toggle} from "./toggle.js";
import {useSaving} from "../hooks/use-saving.js";

const ITEM_CLASS =
	"flex items-center flex-row gap-m leading-base cursor-pointer px-l py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right";
const FLASH_CLASS = "bg-tint text-on-color";
/** Upstream runs a tapped row's action this long after its tint flash. */
const TAP_DELAY_MS = 50;

/** Runs `action`, then closes the sheet unless the action opened another one. */
function runAndClose(action: () => void): void {
	const before = Sheet.get();
	action();
	if (Sheet.get() === before) {
		Sheet.hide();
	}
}

function ItemRow({row}: {row: Extract<MoreMenuRow, {kind: "item"}>}) {
	const [flash, setFlash] = useState(false);
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch menu row: selecting is a tap
		<div
			className={flash ? `${ITEM_CLASS} ${FLASH_CLASS}` : ITEM_CLASS}
			onClick={() => {
				setFlash(true);
				setTimeout(() => {
					runAndClose(row.onSelect);
				}, TAP_DELAY_MS);
			}}
		>
			<FaIcon
				icon={row.icon}
				fixedWidth
				style={row.starred === true ? {color: "var(--wf-text-spark)"} : undefined}
			/>
			<span className="grow">{row.label}</span>
			{row.extra === "chevron-right" && <FaIcon icon="fal:chevron-right" />}
			{row.extra === "toggle" && <Toggle on={row.toggled === true} />}
		</div>
	);
}

function UndoRedoCell({
	label,
	icon,
	enabled,
	run,
}: {
	label: string;
	icon: FaIconKey;
	enabled: boolean;
	run: () => void;
}) {
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch menu row: selecting is a tap
		<div
			className={`flex flex-[1_1_44px] items-center justify-center gap-m py-ml cursor-pointer${enabled ? "" : " opacity-30"}`}
			onClick={() => {
				if (enabled) {
					runAndClose(run);
				}
			}}
		>
			<FaIcon icon={icon} fixedWidth />
			<span>{label}</span>
		</div>
	);
}

function UndoRedoRow({row}: {row: Extract<MoreMenuRow, {kind: "undo-redo"}>}) {
	return (
		<div className="flex items-stretch">
			<UndoRedoCell label="Undo" icon="fal:arrow-rotate-left" enabled={row.canUndo} run={row.onUndo} />
			<div className="my-xs border-r border-solid border-primary" />
			<UndoRedoCell label="Redo" icon="fal:arrow-rotate-right" enabled={row.canRedo} run={row.onRedo} />
		</div>
	);
}

/** The sheet's rows: items, the Undo | Redo pair and separators (adjacent separators hide). */
export function MoreMenuRows({rows}: {rows: readonly MoreMenuRow[]}) {
	return (
		<>
			{rows.map((row, index) => {
				const key = `${row.kind}.${index}`;
				if (row.kind === "separator") {
					return <div key={key} className="border-t border-solid border-primary [&+&]:hidden separator" />;
				}
				return row.kind === "undo-redo" ? <UndoRedoRow key={key} row={row} /> : <ItemRow key={key} row={row} />;
			})}
		</>
	);
}

/** Upstream's save-status footer; the local app tracks only whether a save is in flight. */
function SaveStatus() {
	const saving = useSaving();
	return (
		<div className="h-2xl px-xl pt-s pb-l flex items-center text-tertiary text-s">
			{saving ? "Saving..." : "Autosaved"}
		</div>
	);
}

/** Upstream's `more-menu` sheet body, wired to the local commands. */
export function MobileMoreMenu() {
	const queryClient = useQueryClient();
	const zoomedId = useOutlineStore(activeZoomedId);
	const actions = useHeaderActions(zoomedId);
	const canUndo = useUndoStore((state) => state.canUndo);
	const canRedo = useUndoStore((state) => state.canRedo);
	const expandAll = useExpandAll();
	const deleteNode = useDeleteNode();
	const {navigateToNode} = useNodeNavigation();
	const openSettings = useOutlineStore((state) => state.openSettings);
	const openExportDialog = useOutlineStore((state) => state.openExportDialog);
	const showItemTypePicker = useOutlineStore((state) => state.showItemTypePicker);
	const rows = moreMenuRows({
		zoomedId,
		canUndo,
		canRedo,
		starred: actions.isStarred,
		starsAvailable: true,
		showCompleted: actions.showCompleted,
		completedForced: actions.completedForced,
		canTurnInto: pickerItemTypes([zoomedId ?? HOME_TARGET]).length > 0,
		actions: {
			undo: () => {
				activeCommandRegistry().undo?.execute({items: [], zoomedId});
			},
			redo: () => {
				activeCommandRegistry().redo?.execute({items: [], zoomedId});
			},
			turnInto: () => {
				showItemTypePicker({
					nodeIds: [zoomedId ?? HOME_TARGET],
					position: {top: window.innerHeight / 2, left: window.innerWidth / 2},
				});
			},
			toggleStar: actions.toggleStar,
			share: actions.share,
			exportZoomed: () => {
				void openMenuExport(
					zoomedId,
					async () => {
						const response = await fetch("/api/v1/nodes");
						return response.ok
							? (await readJson<NodeListResponse>(response)).nodes.map((node) => node.id)
							: [];
					},
					openExportDialog,
				);
			},
			expandAll: () => {
				expandAll(zoomedId, true);
			},
			collapseAll: () => {
				expandAll(zoomedId, false);
			},
			deleteZoomed: () => {
				if (zoomedId === null) {
					return;
				}
				const parentId = readNode(queryClient, zoomedId)?.parent_id ?? null;
				deleteNode.mutate(zoomedId);
				navigateToNode(parentId);
			},
			adjustTextSize: () => {
				Sheet.set("font-size");
			},
			toggleCompleted: actions.toggleCompleted,
			openSettings,
		},
	});
	return (
		<div className="more-menu">
			<MoreMenuRows rows={rows} />
			<SaveStatus />
		</div>
	);
}
