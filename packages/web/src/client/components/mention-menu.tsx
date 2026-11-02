import {useCallback} from "react";
import {createPortal} from "react-dom";
import {avatarInitials} from "../mention-options.js";
import type {MentionGroup, MentionOption} from "../mention-options.js";
import {revealInScroller} from "../reveal-in-scroller.js";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";
import {MenuScroller} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader} from "./flyout/menu-item.js";

interface MentionMenuProps
{
	groups: readonly MentionGroup[];
	/** The highlighted row, counted across all groups. */
	index: number;
	keyboardMode: boolean;
	/** The mention chip's viewport left and bottom. */
	left: number;
	top: number;
	onSelect: (index: number) => void;
	onHover: (index: number) => void;
	onMouseMove: () => void;
}

const POSITION_OFFSET = [0, 0] as const;

function label(option: MentionOption)
{
	if (option.kind === "tag")
	{
		return option.text;
	}
	return (
		<>
			<div className="mention-avatar">
				<span
					aria-hidden="true"
					className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-circle bg-tertiary text-secondary font-bold w-full h-full"
				>
					{avatarInitials(option.text)}
				</span>
			</div>
			{option.text}
		</>
	);
}

/**
 * Upstream's `@` mention popup (`dumps/mentions-2026-10-23-upstream-popup.json`): the shared suggest flyout under the
 * chip with a PEOPLE and a TAGS group. Rows carry upstream's literal `" undefined"` class.
 */
export function MentionMenu({groups, index, keyboardMode, left, top, onSelect, onHover, onMouseMove}: MentionMenuProps)
{
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

	const starts = groups.map((_group, groupIndex) =>
		groups.slice(0, groupIndex).reduce((total, previous) => total + previous.options.length, 0),
	);
	return createPortal(
		<Flyout
			align={FlyoutAlign.None}
			position={[left, top]}
			offset={POSITION_OFFSET}
			minWidth={0}
			className="menu mention-popup"
			removeFromDom={false}
		>
			<MenuScroller onMouseMove={onMouseMove}>
				{groups.map((group, groupIndex) =>
				{
					const start = starts[groupIndex] ?? 0;
					return [
						<MenuSectionHeader key={`header-${group.name}`}>
							<span
								data-ascii={`# ${group.name}`}
								className={`mention-group-${group.name.toLowerCase()}`}
							>
								{group.name}
							</span>
						</MenuSectionHeader>,
						...group.options.map((option, optionIndex) =>
						{
							const itemIndex = start + optionIndex;
							const active = itemIndex === index;
							return (
								<MenuItem
									key={`${option.kind}-${option.text}`}
									ref={active && keyboardMode ? scrollActive : undefined}
									label={label(option)}
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
					];
				})}
			</MenuScroller>
		</Flyout>,
		document.body,
	);
}
