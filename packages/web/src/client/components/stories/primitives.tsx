/**
 * Isolated primitive components for Storybook stories.
 * These components are extracted from the main outline components
 * to allow isolated testing without the full app context.
 */

import type {CSSProperties, ReactNode} from "react";

import {expandArrow} from "../expand-arrow.js";
import {resolveLayoutMode} from "../layout-mode.js";
import {ItemCheckbox, itemPrefix} from "../item-prefix.js";

interface BulletDotProps
{
	isCollapsed?: boolean;
	isMirror?: boolean;
}

/**
 * The zoom bullet: upstream's `a.bullet > span.bulletHalo > svg`.
 * A collapsed parent shows the halo; a mirror renders a diamond.
 */
export function BulletDot({isCollapsed = false, isMirror = false}: BulletDotProps)
{
	const classes = ["bullet", isMirror && "diamond", isCollapsed && "bullet--show-halo keep-bullet"]
		.filter(Boolean)
		.join(" ");

	return (
		<a
			href="/#/story-node"
			data-handbook="bullet.handle"
			data-item-id="story-node"
			className={classes}
			style={
			{
				left: "calc(var(--name-left-overhang) + 1px)",
				width: "18px",
				["--bullet-size" as string]: "18px",
			}}
			draggable
			onClick={(event) =>
			{
				event.preventDefault();
			}}
		>
			<span className="bulletHalo">
				{isMirror ? (
					<svg
						width="100%"
						height="100%"
						viewBox="0 0 16 16"
						fill="currentColor"
						className="mirrorDiamondIcon"
					>
						<path d="M8 4 L4 8 L8 12 L12 8 Z" />
					</svg>
				) : (
					<svg width="100%" height="100%" viewBox="0 0 18 18" fill="currentColor" className="zoomBulletIcon">
						<circle cx="9" cy="9" r="3.5" />
					</svg>
				)}
			</span>
		</a>
	);
}

interface ExpandTriangleProps
{
	isExpanded?: boolean;
	onClick?: () => void;
}

/**
 * The expand/collapse triangle indicator.
 * Points right when collapsed, rotates down when expanded.
 */
export function ExpandTriangle({isExpanded = false, onClick}: ExpandTriangleProps)
{
	return expandArrow(
		{
			hasChildren: true,
			isExpanded,
			nodeId: "story",
			onToggle: () => onClick?.(),
		},
	);
}

/** Upstream's nested `div.children`: indented past the parent bullet, the guide line is its left border. */
function ChildrenContainer({children}: {children: ReactNode})
{
	return (
		<div className="children relative ml-[10px] pl-[25px] border-l-[length:var(--wf-border-width-s)] border-solid border-l-secondary [.addedToSelection_&]:border-l-transparent [.item--zooming-in-progress_&]:border-l-transparent">
			{children}
		</div>
	);
}

interface CompleteBulletProps
{
	isExpanded?: boolean;
	isCompleted?: boolean;
	onToggleExpand?: () => void;
}

/**
 * Complete bullet assembly: triangle + dot.
 */
export function CompleteBullet({isExpanded = false, isCompleted = false, onToggleExpand}: CompleteBulletProps)
{
	const indentStyle: CSSProperties =
	{
		position: "relative",
		display: "flex",
		alignItems: "center",
		gap: "4px",
	};

	return (
		<div className={["project", isCompleted && "done"].filter(Boolean).join(" ")} style={indentStyle}>
			<ExpandTriangle isExpanded={isExpanded} onClick={onToggleExpand} />
			<BulletDot isCollapsed={!isExpanded} />
		</div>
	);
}

interface DropLineProps
{
	isVisible?: boolean;
}

/**
 * The drag indicator line shown during drag-and-drop operations.
 */
export function DropLine({isVisible = true}: DropLineProps)
{
	return (
		<div
			className="drop-line"
			style={
			{
				opacity: isVisible ? 1 : 0,
			}}
		>
			<div className="line" />
		</div>
	);
}

interface MenuButtonProps
{
	isVisible?: boolean;
	onClick?: () => void;
}

/**
 * The three-dot menu button that triggers the context menu.
 */
export function MenuButton({isVisible = true, onClick}: MenuButtonProps)
{
	if (!isVisible)
	{
		return null;
	}
	return (
		<button aria-label="More actions" className="itemMenu" onClick={onClick} type="button">
			<div>
				<span className="block size-xl rounded-[12px] text-tertiary hover:bg-tertiary">
					<svg viewBox="0 0 24 24" fill="currentColor" className="block size-full">
						<circle cx="6" cy="12" r="2" />
						<circle cx="12" cy="12" r="2" />
						<circle cx="18" cy="12" r="2" />
					</svg>
				</span>
			</div>
		</button>
	);
}

interface NoteDisplayProps
{
	content: string;
	/** The note is focused: upstream's `active` unclamps it. */
	isActive?: boolean;
}

/**
 * Note display component: upstream's always-contenteditable `.notes > .content`.
 */
export function NoteDisplay({content, isActive = false}: NoteDisplayProps)
{
	if (!content.trim())
	{
		return null;
	}

	return (
		<div className="notes">
			<div
				className={`notranslate content text-tertiary whitespace-pre-wrap overflow-hidden${isActive ? " active" : ""}`}
				contentEditable
				suppressContentEditableWarning
			>
				<span
					className="innerContentContainer"
					dangerouslySetInnerHTML={
					{
						__html: content,
					}}
				/>
			</div>
		</div>
	);
}

interface StaticNodeProps
{
	name: string;
	note?: string;
	isCompleted?: boolean;
	isExpanded?: boolean;
	isEditing?: boolean;
	layoutMode?: string | null;
	onToggleExpand?: () => void;
	children?: ReactNode;
}

/**
 * Static node component for stories (no state management).
 */
export function StaticNode({
	name,
	note = "",
	isCompleted = false,
	isExpanded = false,
	isEditing = false,
	layoutMode = null,
	onToggleExpand,
	children,
}: StaticNodeProps)
{
	const layout = resolveLayoutMode(layoutMode);
	const projectClasses = ["font-custom project", isCompleted && "done", note && "noted", ...layout.projectClasses]
		.filter(Boolean)
		.join(" ");

	return (
		<div className={projectClasses}>
			<div className="name">
				<BulletDot />
				{layout.isTodo
					? itemPrefix([
							<ItemCheckbox
								key="todo"
								isCompleted={isCompleted}
								onComplete={() =>
								{
								}}
							/>,
						])
					: null}
				<div className="notranslate content whitespace-pre-wrap">
					<div
						className="content-editable"
						dangerouslySetInnerHTML={
						{
							__html: name,
						}}
					/>
				</div>
				<ExpandTriangle isExpanded={isExpanded} onClick={onToggleExpand} />
				<MenuButton isVisible={isEditing} />
			</div>
			{note && <NoteDisplay content={note} />}
			<DropLine isVisible={false} />
			{children === undefined ? null : <ChildrenContainer>{children}</ChildrenContainer>}
		</div>
	);
}
