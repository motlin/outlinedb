import {createPortal} from "react-dom";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";
import {MenuScroller} from "./flyout/menu.js";
import {MenuItem} from "./flyout/menu-item.js";
import {menuKeyboard} from "./flyout/menu-keyboard.js";
import {popperTransform} from "./flyout/place-popper.js";

/** `attached`: a tag query is being tracked; `visible`: not dismissed by Escape; `active`: the highlighted row, -1 for none. */
export interface TagPopupState
{
	attached: boolean;
	visible: boolean;
	active: number;
}

export interface TagPopupKeyResult
{
	state: TagPopupState;
	/** The row to accept, if any. */
	accept: number | null;
	/** The popup took the key: preventDefault and stopPropagation so the editor never sees it. */
	preventDefault: boolean;
}

interface TagPopupKeyEvent
{
	key: string;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	isComposing?: boolean;
}

/**
 * Upstream tag autocomplete's keys while its popup shows: arrows walk the rows (the shared DomKit
 * menu step), Tab/Enter accept the active row (or hide the popup with none) and are always swallowed (no indent, no new row),
 * and Escape only hides; a hidden or detached popup leaves every key to the editor.
 */
// oxlint-disable-next-line react/only-export-components -- pure key rules, tested beside the popup
export function tagPopupKey(state: TagPopupState, event: TagPopupKeyEvent, count: number): TagPopupKeyResult
{
	const pass: TagPopupKeyResult =
	{
		state,
		accept: null,
		preventDefault: false,
	};
	if (!state.attached || !state.visible || event.isComposing === true)
	{
		return pass;
	}
	if (event.key === "Escape")
	{
		return {
			state:
			{
				...state,
				visible: false,
			},
			accept: null,
			preventDefault: true,
		};
	}
	if (event.key === "Enter" || event.key === "Tab")
	{
		if (state.active >= 0 && state.active < count)
		{
			return {
				state,
				accept: state.active,
				preventDefault: true,
			};
		}
		return {
			state:
			{
				...state,
				visible: false,
			},
			accept: null,
			preventDefault: true,
		};
	}
	const step = menuKeyboard(
		{
			index: state.active,
			hidden: false,
			keyboardMode: true,
		},
		{
			key: event.key,
			ctrlKey: event.ctrlKey ?? false,
			shiftKey: event.shiftKey ?? false,
			composing: false,
		},
		{
			count,
			cyclic: false,
			selectOnTab: true,
			stopPropagation: true,
		},
	);
	return step.action === "move"
		?
			{
				state:
				{
					...state,
					active: step.state.index,
				},
				accept: null,
				preventDefault: true,
			}
		: pass;
}

/** Any input re-shows a popup Escape hid while it stays attached. */
// oxlint-disable-next-line react/only-export-components -- pure input rule, tested beside the popup
export function tagPopupInput(state: TagPopupState): TagPopupState
{
	return {
		...state,
		visible: true,
	};
}

interface TagAutocompletePopupProps
{
	tags: readonly string[];
	active: number;
	/** Viewport point just after the `#`: its left and bottom. */
	left: number;
	top: number;
	onAccept: (index: number) => void;
}

/**
 * Upstream's tag autocomplete popup (`dumps/tags-autocomplete-upstream-popup.html`): a fixed popper
 * wrapper at the anchor holding a DomKit flyout menu. Hover never moves the active row; mousedown on
 * a row accepts it while keeping the editor focused.
 */
export function TagAutocompletePopup({tags, active, left, top, onAccept}: TagAutocompletePopupProps)
{
	return createPortal(
		<div
			className="z-[100]"
			style={
			{
				position: "fixed",
				inset: "0px auto auto 0px",
				transform: popperTransform(left, top, globalThis.devicePixelRatio || 1),
			}}
			data-popper-reference-hidden="false"
			data-popper-escaped="false"
			data-popper-placement="bottom-start"
		>
			<Flyout align={FlyoutAlign.None} className="menu " minWidth="100%" removeFromDom={false}>
				<MenuScroller>
					{tags.map((tag, index) => (
						<MenuItem
							key={tag}
							label={tag}
							isSelected={index === active}
							isInKeyboardMode
							onMouseDown={() =>
							{
								onAccept(index);
							}}
						/>
					))}
				</MenuScroller>
			</Flyout>
		</div>,
		document.body,
	);
}
