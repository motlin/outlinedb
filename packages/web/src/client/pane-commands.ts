import {isFeatureOn} from "./features.js";
import type {Command, CommandContext, CommandRegistry} from "./keys/dispatch.js";
import {MAIN_PANE_ID, findPane, paneMoveIndex} from "./pane-ids.js";
import type {OpenPaneOptions} from "./stores/outline.js";

/** The slice of the outline store the pane commands read and drive. */
export interface PaneCommandStore
{
	getState: () =>
	{
		panes: readonly
		{
			id: string;
			zoomedId: string | null;
		}[];
		activePaneId: string;
		zoomedNodeId: string | null;
		openPane: (zoomedId: string | null, options?: OpenPaneOptions) => string;
		closePane: (paneId: string) => void;
		closeAllPanes: () => void;
	};
	/** Close the main pane: the first pane becomes the main outline (its zoom navigates the URL). */
	closeMainPane: () => void;
	/** Move pane `paneId` (`main` for the main pane) to workspace index `index`, navigating when the main pane changes. */
	movePane: (paneId: string, index: number) => void;
}

/**
 * Upstream's `new_pane` (⌃R), `close_pane` (⌃⌘W), and the unbound `move_pane_left` / `move_pane_right` (header kebab). New pane opens a pane on the active pane's zoom after the last
 * pane, from the active pane. Close pane closes the active pane; closing the main pane makes the first pane the main
 * outline. Both combos stay claimed when the command has nothing to do, so ⌃R never reloads the page.
 */
export function paneCommands(store: PaneCommandStore): CommandRegistry
{
	return {
		new_pane:
		{
			execute()
			{
				if (!isFeatureOn("side_pane"))
				{
					return;
				}
				const {panes, activePaneId, zoomedNodeId, openPane} = store.getState();
				const active = findPane(panes, activePaneId);
				openPane(
					active === undefined ? zoomedNodeId : active.zoomedId,
					{
						sourcePaneId: active === undefined ? MAIN_PANE_ID : active.id,
					},
				);
			},
		},
		close_pane:
		{
			execute()
			{
				const {panes, activePaneId, closePane} = store.getState();
				if (panes.length === 0)
				{
					return;
				}
				if (findPane(panes, activePaneId) === undefined)
				{
					store.closeMainPane();
				}
				else
				{
					closePane(activePaneId);
				}
			},
		},
		/** Upstream's unbound `toggle_panes`: close every pane when any is open, else open the focused (or zoomed) item in one. */
		toggle_panes:
		{
			execute(ctx)
			{
				if (!isFeatureOn("side_pane"))
				{
					return;
				}
				const {panes, activePaneId, closeAllPanes, openPane} = store.getState();
				if (panes.length > 0)
				{
					closeAllPanes();
				}
				else
				{
					openPane(
						ctx.items[0] ?? ctx.zoomedId,
						{
							sourcePaneId: findPane(panes, activePaneId)?.id ?? MAIN_PANE_ID,
						},
					);
				}
			},
		},
		move_pane_left: movePaneCommand(store, "left"),
		move_pane_right: movePaneCommand(store, "right"),
	};
}

/** Upstream's `move_pane_left` / `move_pane_right`: move the active pane one place, while `canPlacePane` allows it. */
function movePaneCommand(store: PaneCommandStore, direction: "left" | "right")
{
	const target = (): number | null =>
	{
		const state = store.getState();
		return paneMoveIndex(state, state.activePaneId, direction);
	};
	return {
		available: () => target() !== null,
		execute()
		{
			const index = target();
			if (index !== null)
			{
				store.movePane(store.getState().activePaneId, index);
			}
		},
	};
}

/** The slice of the outline store Open in Pane drives. */
export interface OpenInPaneState
{
	panes: readonly
	{
		id: string;
	}[];
	activePaneId: string;
	openPane: (zoomedId: string | null, options?: OpenPaneOptions) => string;
}

/**
 * Upstream's `open_in_pane` (bullet menu, ⌘-click on an internal link): open a new pane on the item right after the
 * source pane (the active pane by default; the link's pane for a ⌘-click) and focus it.
 */
export function openInPane(
	state: OpenInPaneState,
	nodeId: string | null,
	sourcePaneId = state.activePaneId,
	query?: string,
): void
{
	const index = state.panes.findIndex((pane) => pane.id === sourcePaneId);
	state.openPane(
		nodeId,
		{
			index: index + 2,
			sourcePaneId: index === -1 ? MAIN_PANE_ID : sourcePaneId,
			query,
		},
	);
}

/** What the pane navigation commands read and drive: the outline store's pane slice and the main outline's actions. */
export interface PaneNavDeps
{
	getState: () =>
	{
		activePaneId: string;
		panes: readonly
		{
			id: string;
		}[];
		zoomPane: (paneId: string, zoomedId: string | null) => void;
		paneBack: (paneId: string) => void;
		paneForward: (paneId: string) => void;
	};
	/** Commit the edited text before leaving. */
	commitEdit: () => void;
	/** Navigate the main outline home. */
	goHome: () => void;
	/** Step the main outline's Back/Forward stacks. */
	stepMain: (direction: "back" | "forward") => void;
	/** Open today's calendar page in pane `paneId`, or in the main outline for null. */
	navigateToToday: (paneId: string | null) => Promise<void>;
	/** Zoom pane `paneId` (the main outline for null) to its zoom's sibling `step` places away. */
	jumpToSibling: (step: -1 | 1, paneId: string | null) => Promise<void>;
}

/**
 * Home (⌘'), Today (⌃T), Back/Forward and `navigate_to_prev_item` / `navigate_to_next_item` (⇧⌘9 / ⇧⌘0) act on the
 * active pane, as upstream: while an open pane is active they zoom it and step its own history, else they navigate the
 * main outline.
 */
export function paneNavCommands(deps: PaneNavDeps): CommandRegistry
{
	const activePane = (): string | null =>
	{
		const {activePaneId, panes} = deps.getState();
		return findPane(panes, activePaneId)?.id ?? null;
	};
	const step = (direction: "back" | "forward") => (
	{
		execute()
		{
			deps.commitEdit();
			const paneId = activePane();
			if (paneId === null)
			{
				deps.stepMain(direction);
			}
			else if (direction === "back")
			{
				deps.getState().paneBack(paneId);
			}
			else
			{
				deps.getState().paneForward(paneId);
			}
		},
	});
	const jump = (offset: -1 | 1) => (
	{
		execute()
		{
			void deps.jumpToSibling(offset, activePane());
		},
	});
	return {
		navigate_home:
		{
			execute()
			{
				deps.commitEdit();
				const paneId = activePane();
				if (paneId === null)
				{
					deps.goHome();
				}
				else
				{
					deps.getState().zoomPane(paneId, null);
				}
			},
		},
		navigate_backward: step("back"),
		navigate_forward: step("forward"),
		navigate_to_today:
		{
			execute()
			{
				void deps.navigateToToday(activePane());
			},
		},
		navigate_to_prev_item: jump(-1),
		navigate_to_next_item: jump(1),
	};
}

/** The command's item: upstream's `items[0] || WF.Item.focused || WF.Item.zoomed` (null is Home). */
function commandItem(ctx: CommandContext): string | null
{
	return ctx.items[0] ?? ctx.zoomedId;
}

/** What `focus_or_open_pane_N` / `open_in_pane_N` read and drive. */
export interface PaneNumberDeps
{
	getState: () =>
	{
		panes: readonly
		{
			id: string;
			zoomedId: string | null;
			query?: string;
		}[];
		activePaneId: string;
		openPane: (zoomedId: string | null, options?: OpenPaneOptions) => string;
	};
	/**
	 * Upstream's `WF.Panes.focus`: make `paneId` (`main` for the main pane) active and put the caret on its title at
	 * offset 0 (`title`), or, upstream's `WF.Focus.firstChildOfSelected`, on the zoom's first child (`first_child`).
	 */
	focusPane: (paneId: string, caret: "title" | "first_child") => void;
	/** Make `paneId` (`main` for the main outline) active and zoom it to `nodeId` (null for Home), caret in the new view. */
	zoomPaneTo: (paneId: string, nodeId: string | null) => void;
}

/**
 * Upstream's `focus_or_open_pane_1`..`8` (⌃1–8) and `open_in_pane_1`..`8` (⌃⇧1–8). Pane N counts the main pane as 1.
 * Focus-or-open focuses pane N (the main outline's first child for ⌃1 with no pane open), and past the last pane opens
 * the focused item (else the zoomed one) in a new last pane. Open in pane N zooms pane N to that item (the main outline
 * for 1), only focusing it when it already shows the item, and past the last pane opens it in a new last pane.
 */
export function paneNumberCommands(deps: PaneNumberDeps): CommandRegistry
{
	const workspace = () =>
	{
		const {panes} = deps.getState();
		return panes.length === 0
			? []
			: [
					{
						id: MAIN_PANE_ID,
						zoomedId: null,
						query: "",
					},
					...panes,
				];
	};
	const openLast = (ctx: CommandContext): void =>
	{
		const {activePaneId, panes, openPane} = deps.getState();
		openPane(
			commandItem(ctx),
			{
				sourcePaneId: findPane(panes, activePaneId)?.id ?? MAIN_PANE_ID,
			},
		);
	};
	const commands: Record<string, Command> = {};
	for (let number = 1; number <= 8; number++)
	{
		commands[`focus_or_open_pane_${number}`] =
		{
			execute(ctx)
			{
				const pane = workspace()[number - 1];
				if (pane === undefined)
				{
					if (number === 1)
					{
						deps.focusPane(MAIN_PANE_ID, "first_child");
					}
					else
					{
						openLast(ctx);
					}
				}
				else if (pane.id !== deps.getState().activePaneId)
				{
					deps.focusPane(pane.id, "title");
				}
			},
		};
		commands[`open_in_pane_${number}`] =
		{
			execute(ctx)
			{
				const nodeId = commandItem(ctx);
				if (number === 1)
				{
					deps.zoomPaneTo(MAIN_PANE_ID, nodeId);
					return;
				}
				const pane = workspace()[number - 1];
				if (pane === undefined)
				{
					openLast(ctx);
				}
				else if (pane.zoomedId === nodeId && (pane.query ?? "") === "")
				{
					deps.focusPane(pane.id, "title");
				}
				else
				{
					deps.zoomPaneTo(pane.id, nodeId);
				}
			},
		};
	}
	return commands;
}
