import type {MirrorInstance} from "../../mirror-path.js";
import {BOARD_CARD_BULLET_CLASS, BOARD_COLUMN_BULLET_CLASS} from "./board-classes.js";
import {cardBulletClass} from "../dashboard.js";
import {TABLE_CELL_BULLET_CLASS} from "./table-classes.js";
import {bulletClickAction, nodeUrl} from "../navigation.js";

interface NodeBulletProps
{
	nodeId: string;
	/** Where the row sits inside a mirror: its link is the virtual `v_…` location. */
	instance?: MirrorInstance | null;
	isMirror: boolean;
	showHalo: boolean;
	keepBullet: boolean;
	onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
	/** A plain press that did not become a drag; a selected row's bullet clears the selection instead. */
	onZoom: () => void;
	isInSelection: () => boolean;
	onClearSelection: () => void;
	/** A board column or card draws upstream's right-side ring bullet instead of the halo span. */
	board?: "column" | "card";
	/** A dashboard card draws upstream's `bullet.dashboard` ring bullet on the right. */
	dashboardCard?: boolean;
	/** A table cell draws upstream's hover-only ring bullet (a mirror root keeps a diamond always visible). */
	tableCell?: boolean;
	/** The cell is shared (a mirror root's original), so the bullet gains `text-shared`. */
	shared?: boolean;
	/** A phone row's bullet: upstream's `VD4` draws a sized `div` (no href) at half opacity. */
	mobile?:
	{
		size: number;
		left: number;
	};
}

/**
 * The zoom bullet: upstream's `a.bullet > span.bulletHalo > svg`. A collapsed
 * parent shows the halo; a mirror renders a diamond. A press that does not
 * become a drag zooms in. A plain element, not a component, so a resting row mounts no fiber for it.
 */
export function nodeBullet({
	nodeId,
	instance = null,
	isMirror,
	showHalo,
	keepBullet,
	onMouseDown,
	onZoom,
	isInSelection,
	onClearSelection,
	board,
	dashboardCard = false,
	tableCell = false,
	shared = false,
	mobile,
}: NodeBulletProps)
{
	const style =
		mobile === undefined
			?
				{
					left: "calc(var(--name-left-overhang) + 1px)",
					width: "18px",
					["--bullet-size" as string]: "18px",
				}
			:
				{
					left: `${mobile.left}px`,
					width: `${mobile.size}px`,
					opacity: 0.5,
					["--bullet-size" as string]: `${mobile.size}px`,
				};
	const className = dashboardCard
		? cardBulletClass(shared)
		: tableCell
			? [
					"bullet",
					isMirror && "diamond",
					showHalo && "bullet--show-halo",
					"keep-bullet",
					keepBullet && "keep-bullet",
					shared && "text-shared",
					TABLE_CELL_BULLET_CLASS.replace(
						"!opacity-0 group-hover/cell:!opacity-100",
						isMirror ? "!opacity-100" : "!opacity-0 group-hover/cell:!opacity-100",
					),
				]
					.filter(Boolean)
					.join(" ")
			: board === undefined
				? ["bullet", isMirror && "diamond", showHalo && "bullet--show-halo", keepBullet && "keep-bullet"]
						.filter(Boolean)
						.join(" ")
				: [
						"bullet",
						isMirror && "diamond",
						showHalo && "bullet--show-halo",
						"keep-bullet",
						keepBullet && "keep-bullet",
						board === "column" ? BOARD_COLUMN_BULLET_CLASS : BOARD_CARD_BULLET_CLASS,
					]
						.filter(Boolean)
						.join(" ");
	const handleClick = (event: React.MouseEvent<HTMLElement>) =>
	{
		event.stopPropagation();
		// Only a press the drag armed and released before moving 3px acts; a finished drag does not.
		const armed = event.currentTarget.dataset.preDragClick === "true";
		delete event.currentTarget.dataset.preDragClick;
		const action = bulletClickAction(
			{
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				button: event.button,
				armed,
				inSelection: isInSelection(),
			},
		);
		if (action === "browser")
		{
			return;
		}
		event.preventDefault();
		if (action === "clear-selection")
		{
			onClearSelection();
		}
		else if (action === "zoom")
		{
			onZoom();
		}
	};
	const content = dashboardCard ? (
		<>
			<div className="absolute w-8 h-8 rounded-full -z-1 translate-x-[-7px] box-border bg-secondary opacity-0 group-hover/bullet:opacity-100 transition-opacity" />
			<div
				className={`absolute w-[18px] h-[18px] z-1 rounded-full box-border border border-solid ${isMirror ? "border-transparent group-hover/name:border-current" : "border-current"}`}
			/>
			{isMirror ? (
				<svg
					viewBox="0 0 16 16"
					fill="currentColor"
					className="mirrorDiamondIcon relative z-[2] !bg-transparent"
				>
					<path d="M8 4 L4 8 L8 12 L12 8 Z" />
				</svg>
			) : (
				<svg viewBox="0 0 18 18" fill="currentColor" className="relative z-[2] !bg-transparent">
					<circle cx="9" cy="9" r="3.5" />
				</svg>
			)}
		</>
	) : tableCell ? (
		<>
			<div className="absolute w-[24px] h-[24px] rounded-full -z-1 translate-x-[-3px] box-border bg-primary group-hover/bullet:bg-tertiary transition-colors" />
			<div
				className={`circleBorder absolute w-[18px] h-[18px] z-1 rounded-full box-border border border-solid ${isMirror ? "border-transparent group-hover/cell:border-current" : "border-current"}`}
			/>
			{isMirror ? (
				<svg
					viewBox="0 0 16 16"
					fill="currentColor"
					className="mirrorDiamondIcon relative z-[2] !bg-transparent"
				>
					<path d="M8 4 L4 8 L8 12 L12 8 Z" />
				</svg>
			) : (
				<svg viewBox="0 0 18 18" fill="currentColor" className="relative z-[2] !bg-transparent">
					<circle cx="9" cy="9" r="3.5" />
				</svg>
			)}
		</>
	) : board === undefined ? (
		<span className="bulletHalo">
			{isMirror ? (
				<svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor" className="mirrorDiamondIcon">
					<path d="M8 4 L4 8 L8 12 L12 8 Z" />
				</svg>
			) : (
				<svg width="100%" height="100%" viewBox="0 0 18 18" fill="currentColor" className="zoomBulletIcon">
					<circle cx="9" cy="9" r="3.5" />
				</svg>
			)}
		</span>
	) : (
		<>
			<div
				className={`absolute w-[24px] h-[24px] ${board === "column" ? "rounded-full" : "rounded-circle"} -z-1 translate-x-[-3px] box-border bg-tertiary opacity-0 group-hover/bullet:opacity-100 transition-opacity`}
			/>
			<div
				className={`${board === "card" ? "circleBorder " : ""}absolute w-[18px] h-[18px] z-1 rounded-full box-border border border-solid border-current`}
			/>
			<svg viewBox="0 0 18 18" fill="currentColor" className="relative z-[2] !bg-transparent">
				<circle cx="9" cy="9" r="3.5" />
			</svg>
		</>
	);
	const common =
	{
		"data-handbook": "bullet.handle",
		"data-item-id": nodeId,
		className,
		style,
		onMouseDown,
		onClick: handleClick,
	};
	// Upstream's phone bullet is a `div` with no href.
	return mobile === undefined ? (
		<a href={nodeUrl(nodeId, instance)} {...common}>
			{content}
		</a>
	) : (
		<div {...common}>{content}</div>
	);
}
