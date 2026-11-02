import {createDoublePressDetector, handleExpandClick} from "../expansion.js";

/** Shared across arrows so a second click pairs only with the first click on the same row. */
const clickDetector = createDoublePressDetector();

interface ExpandArrowProps
{
	nodeId: string;
	hasChildren: boolean;
	isExpanded: boolean;
	onToggle: (nodeId: string) => void;
	/** When set, a second click within 250ms expands or collapses the whole subtree (upstream arrow double-click). */
	onExpandAll?: (nodeId: string, open: boolean) => void;
	/** Upstream's account setting `always_visible_controls`: the arrow is drawn at rest, else transparent until hover. */
	alwaysVisible?: boolean;
	/** Called after a toggle: upstream puts the caret at the start of the row's text. */
	onFocusRow?: (nodeId: string) => void;
	/** Classes appended after the base ones (a board column or card's hover-only arrow). */
	extraClassName?: string;
	/** A phone row: upstream right-aligns a 30px arrow at half opacity, drawn at rest and scaled 1.2. */
	mobile?: boolean;
}

const EXPAND_CLASS =
	"expand absolute top-0 w-[20px] h-[var(--line-height)] pt-[var(--wf-content-padding-top)] flex items-center justify-center cursor-pointer print:hidden [body.moving_&]:hidden left-[calc(var(--name-left-overhang)_-_22px)]";

/** Upstream's phone arrow: `w-[30px]`, right-aligned below 600px and half opaque. */
const MOBILE_EXPAND_CLASS =
	"expand absolute top-0 w-[30px] h-[var(--line-height)] pt-[var(--wf-content-padding-top)] flex items-center justify-center cursor-pointer print:hidden [body.moving_&]:hidden max-[600px]:-right-xl max-[600px]:left-[unset] max-[600px]:opacity-50 min-[600px]:-left-2xl";

/**
 * Upstream's expand toggle (`a.expand`, kept a button for a11y). A parent shows
 * the triangle, rotated by the `.open` row; a leaf renders it empty and inert. Hook-free and called as a plain
 * function, so a row mounts no fiber for it.
 */
export function expandArrow({
	nodeId,
	hasChildren,
	isExpanded,
	onToggle,
	onExpandAll,
	alwaysVisible = true,
	onFocusRow,
	extraClassName,
	mobile = false,
}: ExpandArrowProps)
{
	const handleClick = (event: Pick<React.MouseEvent, "preventDefault" | "stopPropagation" | "timeStamp">) =>
	{
		event.preventDefault();
		event.stopPropagation();
		if (!onExpandAll)
		{
			if (hasChildren)
			{
				onToggle(nodeId);
			}
			return;
		}
		const plan = handleExpandClick(
			{
				now: event.timeStamp,
				id: nodeId,
				isOpen: isExpanded,
				hasChildren,
				detector: clickDetector,
			},
		);
		if (plan.type === "toggle")
		{
			onToggle(nodeId);
			onFocusRow?.(nodeId);
		}
		else if (plan.type === "all")
		{
			onExpandAll(nodeId, plan.open);
			onFocusRow?.(nodeId);
		}
	};
	const shared =
	{
		"data-handbook": "expand.toggle",
		className: [mobile ? MOBILE_EXPAND_CLASS : EXPAND_CLASS, extraClassName].filter(Boolean).join(" "),
		style:
		{
			color: mobile ? "var(--wf-text-tertiary)" : alwaysVisible ? "var(--wf-text-quinary)" : "transparent",
		},
		onClick: handleClick,
	};
	if (!hasChildren)
	{
		return <button type="button" tabIndex={-1} aria-hidden="true" {...shared} />;
	}
	return (
		<button
			type="button"
			aria-expanded={isExpanded}
			aria-label={isExpanded ? "Collapse" : "Expand"}
			// Upstream's anchor is never focusable; keep a click from moving focus to the button.
			onMouseDown={(event) =>
			{
				event.preventDefault();
			}}
			{...shared}
		>
			<div
				style={
					mobile
						?
							{
								transform: "scale(1.2)",
							}
						: undefined
				}
			>
				<svg
					width="20"
					height="20"
					viewBox="0 0 20 20"
					className="block transition-transform duration-200 ease-base [.open>_.name_&]:rotate-90 [.open.halfExpanded>_.name_&]:rotate-45"
				>
					<path
						d="M13.75 9.56879C14.0833 9.76124 14.0833 10.2424 13.75 10.4348L8.5 13.4659C8.16667 13.6584 7.75 13.4178 7.75 13.0329L7.75 6.97072C7.75 6.58582 8.16667 6.34525 8.5 6.5377L13.75 9.56879Z"
						stroke="none"
						fill="currentColor"
					/>
				</svg>
			</div>
		</button>
	);
}
