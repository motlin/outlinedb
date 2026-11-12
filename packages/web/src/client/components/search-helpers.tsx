import {useEffect, useRef} from "react";
import type {ReactNode, Ref} from "react";
import type {HelperSelection} from "../search/helper-keys.js";
import {FaIcon} from "./fa-icons.js";
import {Flyout} from "./flyout/flyout.js";
import type {FaIconKey} from "./fa-icons.js";

export interface HelperTagLists
{
	hashTags: readonly string[];
	atTags: readonly string[];
}

interface HelperValue
{
	label: string;
	value: string;
}

export interface HelperSection
{
	name: string;
	icon: FaIconKey;
	values: readonly HelperValue[];
	/** Shown in place of chips (the jump-to hint). */
	hint: boolean;
}

function plain(values: readonly string[]): HelperValue[]
{
	return values.map((value) => (
	{
		label: value,
		value,
	}));
}

const DATE_VALUES = plain([
	"date:",
	"date-before:",
	"date-after:",
	"day-of-week:",
	"today",
	"tomorrow",
	"yesterday",
	"this week",
	"next week",
	"last week",
	"this month",
	"next month",
	"last month",
]);

/**
 * Upstream's `search-box.helpers.*` sections in order, keeping only those with values or a component. The @TAGS
 * section always leads with upstream's constant `mentioned:` chip, so it shows even when the zoom has no at-tags.
 */
// oxlint-disable-next-line react/only-export-components -- SearchBox reads the same section list for its keyboard model
export function helperSections(tags: HelperTagLists): HelperSection[]
{
	const sections: HelperSection[] = [
		{
			name: "jumpTo",
			icon: "fal:globe",
			values: [],
			hint: true,
		},
		{
			name: "tags",
			icon: "fal:hashtag",
			values: plain(tags.hashTags),
			hint: false,
		},
		{
			name: "mentions",
			icon: "fal:at",
			values: plain(["mentioned:", ...tags.atTags]),
			hint: false,
		},
		{
			name: "dates",
			icon: "fal:calendar-days",
			values: DATE_VALUES,
			hint: false,
		},
		{
			name: "changes",
			icon: "fal:clock-rotate-left",
			values: plain(["changed:", "created:"]),
			hint: false,
		},
		{
			name: "changedBy",
			icon: "fal:users",
			values: [
				{
					label: "me",
					value: "changed-by:me",
				},
				{
					label: "others",
					value: "changed-by:others",
				},
			],
			hint: false,
		},
		{
			name: "searchOperators",
			icon: "fal:ellipsis",
			values: plain(["is:", "has:", "in:", "text:", "link:", "highlight:"]),
			hint: false,
		},
	];
	return sections.filter((section) => section.hint || section.values.length > 0);
}

// Upstream's class template tail: `border` follows the template's own newline and indentation.
const FLYOUT_CLASS = "menu !-mt-px !px-[5%] !pt-0 !pb-[2px] !bg-primary\n        ";
const TAB_ROW_CLASS = "relative py-s shrink-0 flex justify-around overflow-hidden";
const TAB_ROW_SELECTED_CLASS = `${TAB_ROW_CLASS} after:content-[''] after:absolute after:z-1 after:top-full after:left-0 after:right-0 after:bottom-0 after:h-px after:-mt-px after:bg-header-border`;
const TAB_CLASS = "py-2xs px-ml rounded-[16px]";
const NOOP_HOVER_CHIP = (): void =>
{
};
const CHIP_BASE =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary";
const CHIP_TAIL =
	"mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem !py-0 !px-s !flex text-xs rounded-[16px] [&_span]:whitespace-nowrap [&_span]:text-ellipsis [&_span]:overflow-hidden !text-on-surface";

/** Upstream's chip classes: `hover:bg-secondary` and `canHover` appear only once the mouse has been used over the menu. */
function chipClass(active: boolean, canHover: boolean): string
{
	return [
		CHIP_BASE,
		active && "bg-secondary",
		canHover && "hover:bg-secondary",
		CHIP_TAIL,
		active ? "!bg-secondary active" : "!bg-transparent",
		canHover && "canHover",
	]
		.filter((part) => part !== false)
		.join(" ");
}

/** Upstream's `useDelayedMouseEnter`: the first hover waits 100ms, later ones are instant until the flyout is left. */
const FIRST_HOVER_DELAY_MS = 100;

export interface SearchHelpersProps
{
	query: string;
	focused: boolean;
	autocompletePopulated: boolean;
	tags: HelperTagLists;
	selection: Pick<HelperSelection, "tab" | "chip">;
	onHoverTab: (tab: number) => void;
	/** Upstream selects a chip when the mouse enters it. */
	onHoverChip?: (chip: number) => void;
	/** The mouse has been used over the menu, which switches the chips to their hover classes. */
	canHover?: boolean;
	/** The selection came from the keyboard, so the chip scrolls into view. */
	keyboardMode?: boolean;
	/** A tab was clicked (the globe tab opens the jump menu). */
	onClickTab?: (tab: number) => void;
	onInsert: (value: string) => void;
	/** The jump-menu shortcut named in the hint (`ctrl+k` off mac). */
	jumpKey?: string;
	flyoutRef?: Ref<HTMLDivElement>;
}

function JumpHint({jumpKey}: {jumpKey: string})
{
	return (
		<div className="pt-[5px] pb-[3px] text-[12px] leading-[16px] text-center">
			For the jump to-menu, hit <span className="px-2xs rounded-xs">enter</span> now, <br /> or{" "}
			<span className="px-2xs rounded-xs">{jumpKey}</span> from anywhere.
		</div>
	);
}

function Chips({
	values,
	chip,
	canHover,
	keyboardMode,
	onHoverChip,
	onInsert,
}: {
	values: readonly HelperValue[];
	chip: number;
	canHover: boolean;
	keyboardMode: boolean;
	onHoverChip: (chip: number) => void;
	onInsert: (value: string) => void;
})
{
	const activeChip = useRef<HTMLAnchorElement>(null);
	useEffect(() =>
	{
		if (keyboardMode && chip >= 0)
		{
			activeChip.current?.scrollIntoView(
				{
					behavior: "smooth",
					block: "nearest",
				},
			);
		}
	}, [keyboardMode, chip]);
	return (
		<div className="shrink-0 h-auto flex overflow-hidden [&:not(:last-child)]:mb-ml">
			<div className="relative min-w-0 flex flex-row flex-wrap items-center">
				{values.map(({label, value}, index) => (
					<div className="min-w-0 py-xs px-px" key={value}>
						{/* oxlint-disable-next-line jsx-a11y/anchor-is-valid, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's chips are href-less anchors driven from the search input's keys */}
						<a
							ref={index === chip ? activeChip : undefined}
							className={chipClass(index === chip, canHover)}
							style={
							{
								height: 20,
							}}
							onMouseEnter={() =>
							{
								onHoverChip(index);
							}}
							onClick={() =>
							{
								onInsert(value);
							}}
						>
							<span className="relative flex justify-between items-center">
								<span className="grow flex items-center gap-m whitespace-nowrap text-ellipsis overflow-hidden desktop:text-xs">
									{label}
								</span>
							</span>
						</a>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Upstream's search helper flyout (`Mv4`): a row of icon tabs under the focused search pill whose panels hold the
 * jump-to hint or value chips that edit and commit the query. Selection state lives in `SearchBox`, which owns the
 * input's keys.
 */
export function SearchHelpers({
	query,
	focused,
	autocompletePopulated,
	tags,
	selection,
	onHoverTab,
	onHoverChip = NOOP_HOVER_CHIP,
	canHover = false,
	keyboardMode = false,
	onClickTab,
	onInsert,
	jumpKey = "meta+k",
	flyoutRef,
}: SearchHelpersProps)
{
	const sections = helperSections(tags);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hoverDelay = useRef(FIRST_HOVER_DELAY_MS);
	useEffect(
		() => () =>
		{
			if (hoverTimer.current !== null)
			{
				clearTimeout(hoverTimer.current);
			}
		},
		[],
	);

	const cancelHover = () =>
	{
		if (hoverTimer.current !== null)
		{
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
	};
	const hoverTab = (tab: number) =>
	{
		cancelHover();
		hoverTimer.current = setTimeout(() =>
		{
			hoverTimer.current = null;
			hoverDelay.current = 0;
			onHoverTab(tab);
		}, hoverDelay.current);
	};

	const selected = sections[selection.tab];
	let panel: ReactNode = null;
	if (selected?.hint === true)
	{
		panel = <JumpHint jumpKey={jumpKey} />;
	}
	else if (selected !== undefined)
	{
		panel = (
			<Chips
				values={selected.values}
				chip={selection.chip}
				canHover={canHover}
				keyboardMode={keyboardMode}
				onHoverChip={onHoverChip}
				onInsert={onInsert}
			/>
		);
	}
	const border = query === "" ? "!border-primary" : "!border-[var(--wf-border-tint)]";

	return (
		<div className={focused && !autocompletePopulated ? "" : "hidden"}>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- mousedown only keeps focus in the search input */}
			<Flyout
				surfaceClassName="wf-header"
				rounded
				maxHeight={280}
				minWidth="100%"
				maxWidth="100%"
				className={`${FLYOUT_CLASS}${border}`}
				ref={flyoutRef}
				onMouseDown={(event) =>
				{
					event.preventDefault();
				}}
				onMouseLeave={() =>
				{
					cancelHover();
					hoverDelay.current = FIRST_HOVER_DELAY_MS;
				}}
			>
				<div className={selected === undefined ? TAB_ROW_CLASS : TAB_ROW_SELECTED_CLASS}>
					{sections.map((section, index) => (
						// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- hover and click tab, keyboard goes through the search input
						<div
							key={section.name}
							className={
								index === selection.tab
									? `${TAB_CLASS} !bg-secondary`
									: `${TAB_CLASS} !text-on-surface !bg-transparent`
							}
							onMouseEnter={() =>
							{
								hoverTab(index);
							}}
							onMouseLeave={cancelHover}
							onClick={() =>
							{
								onClickTab?.(index);
							}}
						>
							<FaIcon icon={section.icon} size="sm" />
						</div>
					))}
				</div>
				<div>{panel}</div>
			</Flyout>
		</div>
	);
}
