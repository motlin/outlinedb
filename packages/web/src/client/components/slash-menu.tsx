import {useCallback} from "react";
import {createPortal} from "react-dom";
import {revealInScroller} from "../reveal-in-scroller.js";
import type {SlashCommandOption, SlashGroup, SlashMathOption} from "../slash-commands.js";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";
import {MenuScroller} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader} from "./flyout/menu-item.js";

interface SlashMenuProps
{
	groups: readonly SlashGroup[];
	/** The highlighted row, counted across all groups. */
	index: number;
	keyboardMode: boolean;
	/** The slash chip's viewport left and bottom. */
	left: number;
	top: number;
	onSelect: (index: number) => void;
	onHover: (index: number) => void;
	onMouseMove: () => void;
}

const POSITION_OFFSET = [0, 0] as const;

function isCommand(option: SlashCommandOption | SlashMathOption): option is SlashCommandOption
{
	return "key" in option;
}

/**
 * Upstream's slash menu (`dumps/slash-menu-upstream-dom.html`): a DomKit flyout at the chip's
 * bottom-left, portaled to the body, with one section header per group. Upstream's Suggest passes
 * className `" undefined"`, which lands verbatim in every row's class list.
 */
/** Each group's first row in the menu's flat row order. */
function groupStarts(
	groups: readonly
	{
		options: readonly unknown[];
	}[],
): number[]
{
	const starts: number[] = [];
	let next = 0;
	for (const group of groups)
	{
		starts.push(next);
		next += group.options.length;
	}
	return starts;
}

export function SlashMenu({groups, index, keyboardMode, left, top, onSelect, onHover, onMouseMove}: SlashMenuProps)
{
	// Attaching the ref to a newly active row reveals it inside the menu's scroller, like upstream's keyboard-mode effect.
	const scrollActive = useCallback((element: HTMLAnchorElement | null) =>
	{
		if (element !== null)
		{
			revealInScroller(element);
		}
	}, []);

	if (!groups.some((group) => group.options.length > 0))
	{
		return null;
	}

	const starts = groupStarts(groups);
	return createPortal(
		<Flyout
			align={FlyoutAlign.None}
			position={[left, top]}
			offset={POSITION_OFFSET}
			minWidth={0}
			className="menu "
			removeFromDom={false}
		>
			<MenuScroller onMouseMove={onMouseMove}>
				{groups.map((group, groupIndex) => [
					<MenuSectionHeader key={`header-${group.name}`}>
						<span data-ascii={`# ${group.name}`} className={`mention-group-${group.name.toLowerCase()}`}>
							{group.name}
						</span>
					</MenuSectionHeader>,
					...group.options.map((option: SlashCommandOption | SlashMathOption, optionIndex) =>
					{
						const itemIndex = (starts[groupIndex] ?? 0) + optionIndex;
						const active = itemIndex === index;
						const command = isCommand(option) ? option : undefined;
						return (
							<MenuItem
								key={command?.key ?? `math-${option.label}`}
								ref={active && keyboardMode ? scrollActive : undefined}
								label={command === undefined ? option.label : <span>{option.label}</span>}
								handbook={command?.key}
								icon={command?.icon}
								className=" undefined"
								isSelected={keyboardMode && active}
								isInKeyboardMode={keyboardMode}
								onMouseEnter={() =>
								{
									onHover(itemIndex);
								}}
								onSelect={() =>
								{
									onSelect(itemIndex);
								}}
							/>
						);
					}),
				])}
			</MenuScroller>
		</Flyout>,
		document.body,
	);
}
