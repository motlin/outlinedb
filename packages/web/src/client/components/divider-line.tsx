import type {MouseEvent} from "react";

/** Upstream's divider line class string, newlines and indentation included. */
const DIVIDER_LINE_CLASS =
	"\n    divider-line h-[var(--line-height)]\n    flex flex-1 items-center min-w-[24px]\n    cursor-text\n    name--item-selection-handle\n    name--meta-match-target\n  ";

/** One of the two rules flanking a divider's label; clicking it edits the divider. */
export function DividerLine({onActivate}: {onActivate: () => void})
{
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- mouse shortcut for editing; keyboard users reach the row with the arrow keys
		<div
			className={DIVIDER_LINE_CLASS}
			onClick={(event: MouseEvent) =>
			{
				event.preventDefault();
				event.stopPropagation();
				onActivate();
			}}
		>
			<hr
				className="w-full h-px border-0 border-t border-solid border-color text-center m-0 mt-xs"
				style={
				{
					borderTopColor: "var(--wf-border-primary)",
				}}
			/>
		</div>
	);
}
