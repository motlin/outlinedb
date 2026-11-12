import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {CSSProperties, MouseEvent, ReactElement, ReactNode} from "react";
import {createPortal} from "react-dom";
import {createBreadcrumbLayout, crumbInputsFromKey, crumbInputsKey, measureCrumbLabel} from "../breadcrumb-layout.js";
import type {LayoutCrumb} from "../breadcrumb-layout.js";
import {useContainerRect, useWindowWidth} from "../hooks/use-container-rect.js";
import type {PickerIcon, PickerRow} from "../location-picker-model.js";
import {BreadcrumbSeparator} from "./breadcrumb-separator.js";
import {FaIcon} from "./fa-icons.js";
import type {FaIconKey} from "./fa-icons.js";
import {ButtonMenu} from "./flyout/button-menu.js";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";
import {MenuBody} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader} from "./flyout/menu-item.js";
import {placePopper, popperTransform} from "./flyout/place-popper.js";
import {IconButton} from "./icon-button.js";
import {POPUP_Z} from "./flyout/popover-box.js";
import {domkitInputClass} from "./domkit-input.js";

/** One ancestor shown in a location row's subtext, top-down, Home excluded. */
export interface LocationCrumb
{
	id: string;
	name: string;
}

export interface LocationPickerProps
{
	/** Caret box bottom-left, in page coordinates. */
	position: readonly [number, number];
	/** Step 1 searches for the target; step 2 picks where `New "name" in…` goes. */
	step: 1 | 2;
	/** Step 1 header, e.g. `Move To...`. */
	headerText?: ReactNode;
	subActionName?: string;
	/** The query comes from elsewhere (`getFilter`), so there is no input. */
	hideInput?: boolean;
	/** Step 2: the name of the item to create. */
	name?: string;
	query: string;
	onQueryChange: (query: string) => void;
	rows: readonly PickerRow[];
	/** Ancestors of a location, top-down, without Home and without the location itself. */
	crumbsOf: (id: string) => readonly LocationCrumb[];
	/** The reducer's active row, an index into the enabled rows; the menu starts its selection there. */
	active?: number;
	/** `index` counts enabled rows only, matching `reducePicker`'s `select` event. Truthy keeps the picker open. */
	onSelect: (row: PickerRow, index: number) => unknown;
	exit?: () => void;
	/** Escape while open, from a document listener so it fires while focus is in the input. */
	onEscape?: () => void;
	/** Focus moved outside the picker. */
	onFocusLeave?: () => void;
}

// Upstream Cb4's popper wrapper class, template-literal newline included.
const WRAPPER_CLASS = `[&_.flyout]:static [&_.flyout]:m-0 [&_.flyout]:min-w-[480px] [&_.flyout]:p-0
        [&_.flyout:empty]:hidden [&_.flyout.menu]:border-0 [&_.flyout.menu]:rounded-none `;

const INPUT_CLASS = domkitInputClass();

const MENU_MAX_HEIGHT = 240;

const FOOTER_STYLE: CSSProperties =
{
	height: 32,
	display: "flex",
	alignItems: "center",
};
const FOOTER_A_STYLE: CSSProperties =
{
	overflow: "hidden",
	...FOOTER_STYLE,
	borderTop: "1px solid var(--wf-border-primary)",
};

const STRING_ICONS: Partial<Record<NonNullable<PickerIcon>, FaIconKey>> =
{
	clock: "fal:clock",
	ellipsis: "fal:ellipsis",
	plus: "fal:plus",
};

/** Upstream passes clock/ellipsis/plus as icon names (fa-fw, subtext ml-xl) and star/arrow-up as elements. */
function rowIcon(icon: PickerIcon): FaIconKey | ReactElement | undefined
{
	if (icon === "star")
	{
		return (
			<FaIcon
				icon="fas:star"
				style={
				{
					color: "var(--wf-yellow-200)",
				}}
			/>
		);
	}
	if (icon === "arrow-up")
	{
		return (
			<FaIcon
				icon="fal:arrow-up"
				style={
				{
					transform: "rotate(45deg)",
				}}
			/>
		);
	}
	return icon === null ? undefined : STRING_ICONS[icon];
}

const CRUMB_CLASS = `breadcrumb-item flex-shrink-0 whitespace-nowrap overflow-hidden truncate opacity-70
    data-hj-suppress hover:pointer-fine:opacity-100 hover:pointer-fine:underline cursor-pointer`;
const OVERFLOW_MENU_GUTTER = 48;

// Upstream's location rows pass `sizes: {minItemWidth: 80}` and `threeDotPosition: "left"`.
const layout = createBreadcrumbLayout(
	{
		minItemWidth: 80,
		threeDotPosition: "left",
	},
	(label) => measureCrumbLabel(label),
);

/** A disabled upstream `.breadcrumb-item`: a plain div, narrowed to its truncation width. */
function LocationCrumbItem({item}: {item: LayoutCrumb})
{
	return (
		<div
			style={
			{
				maxWidth: item.truncateWidth ?? undefined,
			}}
			className={CRUMB_CLASS}
		>
			{item.label}
		</div>
	);
}

/**
 * Upstream GuiCrumbs.Widget with hideCurrent, showLastSeparator and itemsDisabled: plain divs, Home for top level,
 * the widest crumbs truncated and the leftmost collapsed into an ellipsis menu to fit the row.
 */
export function LocationCrumbs({crumbs}: {crumbs: readonly LocationCrumb[]})
{
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerLeft, containerWidth] = useContainerRect(containerRef);
	const windowWidth = useWindowWidth();
	const shown =
		crumbs.length === 0
			? [
					{
						id: "None",
						name: "Home",
					},
				]
			: crumbs;
	const inputs = shown.map(({id, name}) => (
	{
		id,
		label: name,
	}));
	const inputsKey = crumbInputsKey(inputs);
	const visible = useMemo(
		() => layout.calculateVisibleItems(crumbInputsFromKey(inputsKey), containerWidth, []),
		[containerWidth, inputsKey],
	);
	const chunks = layout.getItemGroupsWithLeftOffset(layout.getItemGroups(visible));
	return (
		<div
			ref={containerRef}
			className="breadcrumbs grow shrink min-w-0 flex gap-m items-center text-s leading-base overflow-hidden"
			style={
			{
				height: 24,
				color: "var(--wf-text-primary)",
			}}
		>
			{chunks.flatMap(({items, leftOffset}) =>
			{
				if (items[0]?.group === 1)
				{
					return [
						<ButtonMenu
							key={`more-${leftOffset}`}
							actOnHover
							button={
								<IconButton size="md">
									<FaIcon icon="fal:ellipsis" />
								</IconButton>
							}
						>
							<div
								className="flex flex-col items-stretch gap-m px-m breadcrumb-overflow-menu"
								style={
								{
									maxWidth: windowWidth - leftOffset - containerLeft - OVERFLOW_MENU_GUTTER,
								}}
							>
								{items.map((item) => (
									<div key={item.id}>
										<LocationCrumbItem item={item} />
									</div>
								))}
							</div>
						</ButtonMenu>,
						<BreadcrumbSeparator key={`breadcrumb-icon-${leftOffset}`} />,
					];
				}
				return items.flatMap((item) => [
					<LocationCrumbItem key={item.id} item={item} />,
					<BreadcrumbSeparator key={`${item.id}-separator`} />,
				]);
			})}
		</div>
	);
}

interface LocationRowProps
{
	row: PickerRow;
	crumbs?: readonly LocationCrumb[];
	style?: CSSProperties;
	bottomSticky?: boolean;
	isSelected?: boolean;
	isInKeyboardMode?: boolean;
	onSelect?: () => unknown;
	onMouseEnter?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** Upstream `Zf` (e92): a MenuItem with an HTML label and a breadcrumb subtext. */
function LocationRow({
	row,
	crumbs,
	style,
	bottomSticky,
	isSelected,
	isInKeyboardMode,
	onSelect,
	onMouseEnter,
}: LocationRowProps)
{
	// The default-location footer's label is a fragment upstream, so it is not wrapped in an inner div.
	const label =
		row.kind === "create-default" ? (
			<div
				data-menu-item-label=""
				className="flex flex-row gap-m"
				dangerouslySetInnerHTML={
				{
					__html: row.labelHtml,
				}}
			/>
		) : (
			<div data-menu-item-label="" className="flex flex-row gap-m">
				<div
					dangerouslySetInnerHTML={
					{
						__html: row.labelHtml,
					}}
				/>
			</div>
		);
	return (
		<MenuItem
			icon={rowIcon(row.icon)}
			label={label}
			subtext={crumbs && <LocationCrumbs crumbs={crumbs} />}
			isSelected={isSelected}
			isInKeyboardMode={isInKeyboardMode}
			onSelect={onSelect}
			onMouseEnter={onMouseEnter}
			disabled={row.disabled}
			style={style}
			bottomSticky={bottomSticky}
			className={`
        [&:not(:last-child)]:mb-xs
        [&_.menuItemIcon]:w-auto
        ${row.disabled ? "[&_span]:text-inherit" : "[&.active]:bg-secondary [&.canHover:hover]:bg-secondary"}
        `}
		/>
	);
}

LocationRow.componentType = "menuItem" as const;

function renderRow(row: PickerRow, index: number, props: LocationPickerProps): ReactElement
{
	if (row.kind === "help")
	{
		return (
			<div key="help" className="help-text">
				{row.labelHtml}
			</div>
		);
	}
	const footer = row.kind === "create-default" || row.kind === "create-elsewhere";
	let style: CSSProperties | undefined;
	if (row.kind === "create-default")
	{
		style = FOOTER_A_STYLE;
	}
	else if (footer)
	{
		style = FOOTER_STYLE;
	}
	return (
		<LocationRow
			key={row.id === undefined ? row.kind : `${row.kind}-${row.id}`}
			row={row}
			crumbs={row.id === undefined ? undefined : props.crumbsOf(row.id)}
			style={style}
			bottomSticky={footer}
			onSelect={() => props.onSelect(row, index)}
		/>
	);
}

/** Upstream `bb4`: the popper div at `position`, bottom-start, clamped 10px inside the viewport, never flipped. */
function usePopperPosition(position: readonly [number, number])
{
	const ref = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<readonly [number, number]>(position);
	useLayoutEffect(() =>
	{
		const element = ref.current;
		if (!element)
		{
			return;
		}
		const {x, y} = placePopper(
			{
				reference:
				{
					left: position[0],
					top: position[1],
					width: 0,
					height: 0,
				},
				popper:
				{
					width: element.offsetWidth,
					height: element.offsetHeight,
				},
				placement: "bottom-start",
				viewport:
				{
					width: window.innerWidth,
					height: Number.POSITIVE_INFINITY,
				},
			},
		);
		setPlaced([x, y]);
	}, [position]);
	return {
		ref,
		placed,
	};
}

/** Upstream's step-1 document keydown listener: Escape is the picker's, before the menu or editor see it. */
function useEscape(onEscape: (() => void) | undefined)
{
	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent) =>
		{
			if (onEscape && event.key === "Escape")
			{
				event.preventDefault();
				event.stopPropagation();
				onEscape();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () =>
		{
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onEscape]);
}

/** Enabled-row index of each row (disabled rows get -1), as the menu and `reducePicker` count them. */
function enabledIndexes(rows: readonly PickerRow[]): number[]
{
	let next = 0;
	return rows.map((row) => (row.disabled ? -1 : next++));
}

/** Upstream WF.InlineSearch picker (`Bp` desktop `Cb4` + steps `Lm1`/`Mm1` + results list `KM`). */
export function LocationPicker(props: LocationPickerProps)
{
	const
	{
		position,
		step,
		headerText,
		subActionName,
		hideInput = false,
		name = "",
		query,
		onQueryChange,
		rows,
		active = 0,
		exit,
	} = props;
	const {onFocusLeave} = props;
	const {ref, placed} = usePopperPosition(position);
	useEscape(props.onEscape);
	// Upstream's WF.Scroll.reveal(b, {boundary: row, inline: "center"}) on each highlighted match as its row mounts.
	const rowKey = rows.map((row) => row.labelHtml).join("\n");
	const revealedKey = useRef<string | null>(null);
	useLayoutEffect(() =>
	{
		if (revealedKey.current === rowKey)
		{
			return;
		}
		revealedKey.current = rowKey;
		for (const match of ref.current?.querySelectorAll("a.menuItem [data-menu-item-label] b") ?? [])
		{
			match.scrollIntoView(
				{
					inline: "center",
					block: "nearest",
				},
			);
		}
	});
	const indexes = enabledIndexes(rows);
	const header =
		step === 1 ? (
			headerText
		) : (
			<>
				{subActionName === undefined || subActionName === "" ? "New" : subActionName} &quot;<b>{name}</b>&quot;
				in…
			</>
		);
	let menuClass = "[&_.help-text]:pt-0 [&_.help-text]:px-l [&_.help-text]:pb-l";
	if (step === 1)
	{
		menuClass = `[&_.help-text]:p-l ${query ? "[&_.help-text]:pt-m" : ""}`;
	}
	return createPortal(
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the mousedown only keeps the editor's caret; upstream's wrapper is a bare div
		<div
			ref={ref}
			className={WRAPPER_CLASS}
			data-popper-reference-hidden="false"
			data-popper-escaped="false"
			data-popper-placement="bottom-start"
			style={
			{
				position: "absolute",
				inset: "0 auto auto 0",
				zIndex: POPUP_Z,
				transform: popperTransform(placed[0], placed[1], globalThis.devicePixelRatio || 1),
			}}
			// A filter-driven picker (`[[`) sits beside an editor that keeps the caret: pressing a row must not blur it.
			onMouseDown={
				hideInput
					? (event) =>
						{
							event.preventDefault();
						}
					: undefined
			}
			onBlur={(event) =>
			{
				if (onFocusLeave && !event.currentTarget.contains(event.relatedTarget))
				{
					onFocusLeave();
				}
			}}
		>
			<Flyout expanded position={position} align={FlyoutAlign.Left}>
				<MenuSectionHeader>{header}</MenuSectionHeader>
				{!hideInput && (
					<div className={step === 1 ? "p-l pt-0 mobile:pl-ml" : "pt-0 pb-l px-l mobile:pl-ml"}>
						<div className="flex flex-col w-full">
							<input
								// Keyed by step: each step mounts its own autofocused input, as upstream's Lm1/Mm1 do.
								key={step}
								className={INPUT_CLASS}
								type="text"
								placeholder="Find location..."
								value={query}
								onChange={(event) =>
								{
									onQueryChange(event.currentTarget.value);
								}}
								// oxlint-disable-next-line jsx-a11y/no-autofocus -- upstream's picker input autofocuses
								autoFocus
							/>
						</div>
					</div>
				)}
				<div>
					<Flyout
						expanded
						removeFromDom={false}
						align={FlyoutAlign.Left}
						className={`menu ${menuClass} !static`}
					>
						<MenuBody
							unwrapped
							keyboardMode
							initialSelect={active}
							cyclicNavigation
							stopKeydownEventPropagation
							maxHeight={MENU_MAX_HEIGHT}
							exit={exit}
						>
							{rows.map((row, index) => renderRow(row, indexes[index] ?? -1, props))}
						</MenuBody>
					</Flyout>
				</div>
			</Flyout>
		</div>,
		document.body,
	);
}
