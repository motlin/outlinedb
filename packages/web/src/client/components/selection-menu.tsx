import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {CSSProperties} from "react";
import {createPortal} from "react-dom";
import {activeCommandRegistry} from "../hooks/use-global-keymap.js";
import {commandTargets, selectionMenuAnchor} from "../item-selection.js";
import type {SelectionState} from "../item-selection.js";
import type {CommandContext} from "../keys/dispatch.js";
import {hint} from "../keys/hint.js";
import {readNode} from "../node-cache.js";
import {buildSelectionMenu} from "../selection-menu-model.js";
import type {SelectionMenuEntry} from "../selection-menu-model.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {currentSelectionView} from "../hooks/use-selection-keymap.js";
import {maintainFocus} from "../focus-maintain.js";
import {liveFocusEnv} from "../focus-maintain-env.js";
import {MenuBody} from "./flyout/menu.js";
import {MenuItem, MenuSeparator} from "./flyout/menu-item.js";
import {placeSideMenu} from "./flyout/place-popper.js";
import type {SideMenuPosition} from "./flyout/place-popper.js";
import {popoverBox} from "./flyout/popover-box.js";

/** The `.project` row element of `id` in any pane, or null when it is not rendered. */
function projectElement(id: string): HTMLElement | null
{
	const content = document.querySelector(`.innerContentContainer[data-node-id="${CSS.escape(id)}"]`);
	return content?.closest<HTMLElement>(".project") ?? null;
}

const MENU_CLASS_NAME = (() =>
{
	const box = popoverBox(
		{
			minWidth: 144,
			maxWidth: 240,
		},
	);
	return `
            [.moving_&]:hidden
            ${box.className}
            flyout menu selection-menu
          `;
})();

const MENU_BOX_STYLE = popoverBox(
	{
		minWidth: 144,
		maxWidth: 240,
	},
).style;

export interface SelectionMenuViewProps
{
	/** The row beside which the menu floats: upstream's last selected row that has a rendered element. */
	anchor: HTMLElement;
	entries: readonly SelectionMenuEntry[];
	/** The footer count: every top-level selection entry. */
	count: number;
	/** Every selected item is read-only: no footer separator. */
	readOnly: boolean;
	onSelect: (id: string) => void;
	/** Called instead of placing the menu when `anchor` has left the DOM, as a move remounts the row. */
	onAnchorLost?: () => void;
}

/** Runs `run` once on the next frame however often `schedule` is called before it. */
function coalescedFrame(run: () => void):
{
	schedule: () => void;
	cancel: () => void;
}
{
	let frame: number | null = null;
	return {
		schedule: () =>
		{
			frame ??= requestAnimationFrame(() =>
			{
				frame = null;
				run();
			});
		},
		cancel: () =>
		{
			if (frame !== null)
			{
				cancelAnimationFrame(frame);
			}
		},
	};
}

function viewportSize():
{
	width: number;
	height: number;
}
{
	return {
		width: document.documentElement.clientWidth,
		height: document.documentElement.clientHeight,
	};
}

type SelectionMenuRowsProps = Omit<SelectionMenuViewProps, "anchor" | "onAnchorLost">;

function sameEntry(a: SelectionMenuEntry | undefined, b: SelectionMenuEntry | undefined): boolean
{
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Equal rows: the host rebuilds `entries` on each render, so they are compared by value. */
function sameRows(previous: SelectionMenuRowsProps, next: SelectionMenuRowsProps): boolean
{
	return (
		previous.count === next.count &&
		previous.readOnly === next.readOnly &&
		previous.onSelect === next.onSelect &&
		previous.entries.length === next.entries.length &&
		previous.entries.every((entry, index) => sameEntry(entry, next.entries[index]))
	);
}

/**
 * The menu's rows and footer; memoized by value, so neither repositioning the menu nor a host render that left the
 * rows as they were re-renders a row.
 */
const SelectionMenuRows = memo(function SelectionMenuRows({entries, count, readOnly, onSelect}: SelectionMenuRowsProps)
{
	return (
		<MenuBody unwrapped disableKeyboard>
			{entries.map((entry, index) =>
				entry.kind === "separator" ? (
					// Separators have no identity beyond their position.
					// oxlint-disable-next-line react/no-array-index-key
					<MenuSeparator key={`separator${index}`} />
				) : (
					<MenuItem
						key={entry.id}
						handbook={entry.id}
						icon={entry.icon}
						label={entry.label}
						shortcut={entry.shortcutCommand === null ? undefined : hint(entry.shortcutCommand)}
						onSelect={() =>
						{
							onSelect(entry.id);
						}}
					/>
				),
			)}
			{!readOnly && <MenuSeparator />}
			<div className="text-center text-tertiary pt-s pb-ml text-xs">{count} items</div>
		</MenuBody>
	);
}, sameRows);

/**
 * Upstream's `.selection-menu` flyout (`uF4`): a `Menu.Static` with no keyboard model and no enter or exit
 * animation, portaled to `body` and positioned by popper `right-start` / `left-start` beside the anchor row.
 * Memoized: it renders when its inputs or its position change, and re-places itself after each cache change, which
 * may move the anchor row, without rendering.
 */
export const SelectionMenuView = memo(function SelectionMenuView({
	anchor,
	entries,
	count,
	readOnly,
	onSelect,
	onAnchorLost,
}: SelectionMenuViewProps)
{
	const queryClient = useQueryClient();
	const menu = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<SideMenuPosition | null>(null);

	const place = useCallback(() =>
	{
		const element = menu.current;
		if (element === null)
		{
			return;
		}
		if (!anchor.isConnected)
		{
			onAnchorLost?.();
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const size = element.getBoundingClientRect();
		const next = placeSideMenu(
			{
				anchor:
				{
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
				},
				popper:
				{
					width: size.width,
					height: size.height,
				},
				viewport: viewportSize(),
			},
		);
		setPosition((current) =>
			current !== null &&
			current.placement === next.placement &&
			current.referenceHidden === next.referenceHidden &&
			current.style.transform === next.style.transform
				? current
				: next,
		);
	}, [anchor, onAnchorLost]);

	// A render may change the rows (and so the menu's size); the guard in `place` stops a render loop.
	useLayoutEffect(() =>
	{
		place();
	});

	useEffect(() =>
	{
		const nextFrame = coalescedFrame(place);
		const unsubscribe = queryClient.getQueryCache().subscribe(nextFrame.schedule);
		globalThis.addEventListener("scroll", place, true);
		globalThis.addEventListener("resize", place);
		return () =>
		{
			unsubscribe();
			nextFrame.cancel();
			globalThis.removeEventListener("scroll", place, true);
			globalThis.removeEventListener("resize", place);
		};
	}, [place, queryClient]);

	const style: CSSProperties =
	{
		position: "fixed",
		inset: position?.style.inset ?? "0px auto auto 0px",
		...MENU_BOX_STYLE,
		transform: position?.style.transform ?? "translate(0px, 0px)",
	};
	return createPortal(
		<div
			ref={menu}
			className={MENU_CLASS_NAME}
			style={style}
			data-popper-reference-hidden={String(position?.referenceHidden ?? false)}
			data-popper-escaped="false"
			data-popper-placement={position?.placement ?? "right-start"}
		>
			<SelectionMenuRows entries={entries} count={count} readOnly={readOnly} onSelect={onSelect} />
		</div>,
		document.body,
	);
});

/** The floating menu of the item selection, mounted once beside the other global hosts; idle without a selection. */
export function SelectionMenu()
{
	const hasSelection = useOutlineStore((state) => state.itemSelection.entries.length > 0);
	return hasSelection ? <SelectionMenuHost /> : null;
}

interface SelectionMenuModel
{
	ctx: CommandContext;
	entries: SelectionMenuEntry[];
	readOnly: boolean;
	/** Changes exactly when `entries` or `readOnly` do. */
	key: string;
}

/** The menu's rows and footer for the current selection, read from the cache and the rendered rows. */
function selectionMenuModel(
	queryClient: QueryClient,
	selection: SelectionState,
	zoomedId: string | null,
): SelectionMenuModel
{
	const view = currentSelectionView(queryClient);
	const items = commandTargets(selection, () => view.tree, null);
	const ctx =
	{
		items,
		zoomedId,
	};
	const registry = activeCommandRegistry();
	const nodes = items.map((id) => readNode(queryClient, id));
	const qualifiers = new Set<string>();
	if (
		items.some((id) =>
		{
			const parentId = readNode(queryClient, id)?.parent_id ?? null;
			const grandparentId = parentId === null ? null : (readNode(queryClient, parentId)?.parent_id ?? null);
			return grandparentId !== null && readNode(queryClient, grandparentId)?.data.layoutMode === "table";
		})
	)
	{
		qualifiers.add("has_table_cell");
	}
	if (items.some((id) => projectElement(id)?.closest("[data-pane-id]") != null))
	{
		qualifiers.add("has_pane_item");
	}
	const entries = buildSelectionMenu(
		{
			available: (id) => registry[id] !== undefined && registry[id].available?.(ctx) !== false,
			allCompleted: nodes.length > 0 && nodes.every((node) => node?.completedAt != null),
			firstEmbedded: false,
			qualifiers,
		},
	);
	const readOnly = nodes.every((node) => node?.readOnly === true);
	return {
		ctx,
		entries,
		readOnly,
		key: JSON.stringify([readOnly, entries]),
	};
}

type MenuAnchor =
{
	element: HTMLElement;
	count: number;
} | null;

/** The row the menu floats beside for `selection`; `previous` itself when that is unchanged. */
function menuAnchor(selection: SelectionState, previous: MenuAnchor): MenuAnchor
{
	const {anchorId, count} = selectionMenuAnchor(selection, (id) => projectElement(id) !== null);
	const element = anchorId === null ? null : projectElement(anchorId);
	if (element === null)
	{
		return null;
	}
	return previous?.element === element && previous.count === count
		? previous
		:
			{
				element,
				count,
			};
}

/** The menu model for the store's current selection, read outside render (a cache event, a click). */
function currentMenuModel(queryClient: QueryClient): SelectionMenuModel
{
	const state = useOutlineStore.getState();
	return selectionMenuModel(queryClient, state.itemSelection, activeZoomedId(state));
}

function SelectionMenuHost()
{
	const queryClient = useQueryClient();
	const selection = useOutlineStore((state) => state.itemSelection);
	const [anchor, setAnchor] = useState<MenuAnchor>(null);
	const zoomedId = useOutlineStore(activeZoomedId);
	// Only the model's key is state: a cache event that leaves the rows as they were renders nothing.
	const [, setModelKey] = useState("");

	// The anchor is captured when the selection changes, like upstream's `selected.changed` listener.
	useLayoutEffect(() =>
	{
		// oxlint-disable-next-line react/set-state-in-effect -- the row element exists in the DOM only after the commit
		setAnchor((previous) => menuAnchor(selection, previous));
	}, [selection]);
	// And again when a move remounts the anchor row.
	const recaptureAnchor = useCallback(() =>
	{
		setAnchor((previous) => menuAnchor(useOutlineStore.getState().itemSelection, previous));
	}, []);

	// Labels such as Complete/Uncomplete track the items' current state. The cache notifies synchronously, even while
	// another component renders (a `useQuery` observer subscribing), so a burst is read once, in a microtask.
	useEffect(() =>
	{
		let scheduled = false;
		let live = true;
		const unsubscribe = queryClient.getQueryCache().subscribe(() =>
		{
			if (scheduled)
			{
				return;
			}
			scheduled = true;
			queueMicrotask(() =>
			{
				scheduled = false;
				if (live)
				{
					setModelKey(currentMenuModel(queryClient).key);
				}
			});
		});
		return () =>
		{
			live = false;
			unsubscribe();
		};
	}, [queryClient]);

	const onSelect = useCallback(
		(id: string) =>
		{
			const {ctx} = currentMenuModel(queryClient);
			maintainFocus(() =>
			{
				activeCommandRegistry()[id]?.execute(ctx);
			}, liveFocusEnv(queryClient));
		},
		[queryClient],
	);

	const model = selectionMenuModel(queryClient, selection, zoomedId);
	if (selection.entries.length === 0 || anchor === null || model.entries.length === 0)
	{
		return null;
	}
	return (
		<SelectionMenuView
			anchor={anchor.element}
			entries={model.entries}
			count={anchor.count}
			readOnly={model.readOnly}
			onSelect={onSelect}
			onAnchorLost={recaptureAnchor}
		/>
	);
}
