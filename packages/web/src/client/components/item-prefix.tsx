import type {ReactNode} from "react";
import {FaIcon} from "./fa-icons.js";

/**
 * Upstream's `ui("item:prefix")` slot: pieces (numbered, then to-do) between the bullet and the
 * content, wrapped in `.prefix` only when at least one exists. Hook-free, so called as a plain
 * function rather than mounted: most rows have no pieces and need no fiber.
 */
export function itemPrefix(pieces: ReactNode[])
{
	if (pieces.length === 0)
	{
		return null;
	}
	return (
		<div
			className="prefix relative top-0 inline-flex items-center justify-center whitespace-nowrap"
			style={
			{
				["--prefix-count" as string]: pieces.length,
			}}
		>
			<div
				style={
				{
					height: 12,
				}}
			/>
			<div className="inline-flex space-x-2 items-center justify-center">{pieces}</div>
		</div>
	);
}

/** Upstream's to-do checkbox: a label around a hidden input; focus never leaves the current editor. */
export function ItemCheckbox({
	isCompleted,
	isZoomRoot = false,
	onComplete,
}: {
	isCompleted: boolean;
	isZoomRoot?: boolean;
	onComplete: () => void;
})
{
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- mouse-only guards: the hidden input is the keyboard-reachable control and the label must not start row editing or take focus
		<label
			className={`item-checkbox${isCompleted ? " checked" : ""}${isZoomRoot ? " zoomed" : ""}`}
			onMouseDown={(event) =>
			{
				event.preventDefault();
				event.stopPropagation();
			}}
			onClick={(event) =>
			{
				event.stopPropagation();
			}}
		>
			<div className="checkbox-bg" />
			<FaIcon
				icon={isCompleted ? "fal:square-check" : "fal:square"}
				className="checkbox-icon"
				style={
				{
					fontSize: isZoomRoot ? "24px" : "16px",
				}}
			/>
			<input type="checkbox" name="complete" checked={isCompleted} onChange={onComplete} tabIndex={-1} />
		</label>
	);
}

/** Upstream's numbered piece: `N.`, struck through and dimmed on a completed row. */
export function NumberPiece({number}: {number: number})
{
	return <span className="[.done_&]:line-through [.done_&]:opacity-[.37]">{number}.</span>;
}
