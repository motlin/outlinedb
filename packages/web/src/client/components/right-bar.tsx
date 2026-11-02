import {useEffect, useState} from "react";
import {IS_MOBILE} from "../is-mobile.js";
import {hint} from "../keys/hint.js";
import {registerRightBarPanel, rightBarPanels, setRightBarLast, shownRightBarPanel} from "../right-bar-panels.js";
import {isMacPlatform} from "../editable-text-keys.js";
import {ErrorBoundary} from "./error-boundary.js";
import {useOutlineStore} from "../stores/outline.js";

interface HotkeyRow
{
	name: string;
	command: string;
	modifier?: (text: string) => string;
}

const paneRange = (text: string): string => `${text}–8`;

/** Upstream's hotkeys panel rows, in upstream order. */
// oxlint-disable-next-line react/only-export-components -- static row table exported for tests
export const HOTKEY_ROWS: readonly HotkeyRow[] = [
	{
		name: "Zoom in",
		command: "zoom_in",
	},
	{
		name: "Zoom out",
		command: "zoom_out",
	},
	{
		name: "Zoom to Today",
		command: "navigate_to_today",
	},
	{
		name: "Expand",
		command: "expand",
	},
	{
		name: "Collapse",
		command: "collapse",
	},
	{
		name: "Indent",
		command: "indent",
	},
	{
		name: "Outdent",
		command: "outdent",
	},
	{
		name: "Move up",
		command: "move_up",
	},
	{
		name: "Move down",
		command: "move_down",
	},
	{
		name: "Focus next sibling",
		command: "focus_next_sibling",
	},
	{
		name: "Focus previous sibling",
		command: "focus_prev_sibling",
	},
	{
		name: "Complete",
		command: "complete",
	},
	{
		name: "Duplicate",
		command: "duplicate",
	},
	{
		name: "Export",
		command: "show_export",
	},
	{
		name: "Delete",
		command: "delete",
	},
	{
		name: "Search",
		command: "focus_or_unfocus_search",
	},
	{
		name: "Show/hide completed",
		command: "show_or_hide_completed",
	},
	{
		name: "Star page",
		command: "star_current_item",
	},
	{
		name: "Navigate home",
		command: "navigate_home",
	},
	{
		name: "Jump menu",
		command: "show_switcher",
	},
	{
		name: "Bold",
		command: "toggle_bold",
	},
	{
		name: "Italic",
		command: "toggle_italic",
	},
	{
		name: "Underline",
		command: "toggle_underline",
	},
	{
		name: "Strikethrough",
		command: "toggle_strikethrough",
	},
	{
		name: "Code",
		command: "toggle_code",
	},
	{
		name: "Toggle left sidebar",
		command: "toggle_leftbar",
	},
	{
		name: "Toggle this sidebar",
		command: "toggle_rightbar",
	},
	{
		name: "Open or focus pane 1–8",
		command: "focus_or_open_pane_1",
		modifier: paneRange,
	},
	{
		name: "Open in pane 1–8",
		command: "open_in_pane_1",
		modifier: paneRange,
	},
	{
		name: "New pane",
		command: "new_pane",
	},
	{
		name: "Close pane",
		command: "close_pane",
	},
	{
		name: "Copy mirror(s) to paste",
		command: "mirror",
	},
	{
		name: "Jump to previous sibling",
		command: "navigate_to_prev_item",
	},
	{
		name: "Jump to next sibling",
		command: "navigate_to_next_item",
	},
	{
		name: "Heading 1",
		command: "toggle_h1",
	},
	{
		name: "Heading 2",
		command: "toggle_h2",
	},
	{
		name: "Heading 3",
		command: "toggle_h3",
	},
	{
		name: "Paragraph",
		command: "toggle_paragraph",
	},
	{
		name: "Code Block",
		command: "toggle_code_block",
	},
	{
		name: "Quote",
		command: "toggle_quote_block",
	},
	{
		name: "Bullet",
		command: "toggle_bullet",
	},
	{
		name: "To do",
		command: "toggle_todo",
	},
	{
		name: "Number",
		command: "toggle_numbered",
	},
	{
		name: "Mark read",
		command: "mark_read",
	},
	{
		name: "Open/close AI Chat",
		command: "toggle_ai_chat",
	},
	{
		name: "Create AI Node",
		command: "toggle_ai_item",
	},
	{
		name: "Jump to previous unread",
		command: "previous_unread",
	},
	{
		name: "Jump to next unread",
		command: "next_unread",
	},
];

function rightBarWidth(): number
{
	return Math.max(16, Math.min(Math.max(400, innerWidth / 4), innerWidth - 16));
}

function useRightBarWidth(): number
{
	const [width, setWidth] = useState(rightBarWidth);
	useEffect(() =>
	{
		const onResize = (): void =>
		{
			setWidth(rightBarWidth());
		};
		addEventListener("resize", onResize);
		return () =>
		{
			removeEventListener("resize", onResize);
		};
	}, []);
	return width;
}

/** Upstream pads the body so page content clears the bar: 0 hidden, the 16px strip collapsed, the full width expanded. */
// oxlint-disable-next-line react/only-export-components -- pure helper exported for tests
export function bodyPaddingRight({show, collapsed, width}: {show: boolean; collapsed: boolean; width: number}): number
{
	if (!show)
	{
		return 0;
	}
	return collapsed ? 16 : width;
}

function useBodyPaddingRight(show: boolean, collapsed: boolean, width: number): void
{
	useEffect(() =>
	{
		document.body.style.paddingRight = `${bodyPaddingRight(
			{
				show,
				collapsed,
				width,
			},
		)}px`;
		document.body.style.transition = "padding-right .35s";
	}, [show, collapsed, width]);
}

function HotkeyRowView({name, command, modifier}: HotkeyRow)
{
	const chip = hint(command, isMacPlatform());
	const text = chip === undefined || modifier === undefined ? chip : modifier(chip);
	return (
		<div title={command} className="font-system leading-base py-xs cursor-help">
			<div className="flex items-center">
				<div className="flex-grow">{name}</div>
				<div className="ml-l min-w-[96px] text-right">
					{text && (
						<span className="inline-flex items-center justify-center rounded-xs bg-quaternary px-2xs py-3xs text-[11px] font-medium tracking-[0.02em] text-secondary">
							{text}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function HotkeyRows()
{
	return (
		<>
			{HOTKEY_ROWS.map((row) => (
				<HotkeyRowView key={row.command} {...row} />
			))}
		</>
	);
}

registerRightBarPanel(
	{
		title: "Hotkeys",
		element: () => <HotkeyRows />,
	},
);

const PILL = "cursor-pointer py-2xs px-ml rounded-[16px]";

function PanelContent()
{
	const shown = shownRightBarPanel();
	const bumpRevision = useOutlineStore((s) => s.rightBarPanelRevision);
	const rerender = useState(0)[1];
	void bumpRevision;
	return (
		<>
			<div className="pb-ml text-base font-bold">
				{rightBarPanels().map(({title}) => (
					// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's pill is a plain span
					<span
						key={title}
						className={`${PILL} ${title === shown?.title ? "!text-on-color !bg-tint" : "!text-on-surface !bg-transparent"}`}
						onClick={() =>
						{
							setRightBarLast(title);
							rerender((n) => n + 1);
						}}
					>
						{title}
					</span>
				))}
			</div>
			<ErrorBoundary>{shown?.element()}</ErrorBoundary>
		</>
	);
}

/** Upstream's right bar: a fixed hotkeys panel that collapses to a 16px strip. A phone has none. */
export function RightBar()
{
	const showSetting = useOutlineStore((s) => s.showKeyboardShortcuts);
	const show = showSetting && rightBarPanels().length > 0;
	const collapsed = useOutlineStore((s) => s.rightBarCollapsed);
	const toggleRightBarCollapsed = useOutlineStore((s) => s.toggleRightBarCollapsed);
	const anyPane = useOutlineStore((s) => s.panes.length > 0);
	const width = useRightBarWidth();
	useBodyPaddingRight(show && !IS_MOBILE, collapsed, width);
	if (IS_MOBILE)
	{
		return null;
	}

	return (
		<div
			className="right-bar inline-flex fixed top-3xl right-0"
			style={
			{
				zIndex: 99,
			}}
		>
			{show && (
				<div
					className={`fixed ${anyPane ? "top-0" : "top-3xl"} right-sal bottom-sal\n        text-xs bg-primary text-secondary transition-transform duration-200 ease-base print:hidden`}
					style={
					{
						width,
						transform: collapsed ? "translateX(calc(100% - var(--wf-space-l)))" : undefined,
						zIndex: 99,
					}}
				>
					<div className="h-full py-xl pl-[calc(var(--wf-space-l)+var(--wf-space-m))] pr-xl box-border overflow-auto">
						<PanelContent />
					</div>
					{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's strip is a plain div; ⌘/ is the keyboard path */}
					<div
						onClick={toggleRightBarCollapsed}
						className="absolute inset-y-0 left-0 w-[var(--wf-space-l)] px-2xs flex items-center border-l border-solid border-primary text-tertiary bg-primary cursor-pointer hover:bg-quaternary"
					>
						{collapsed ? "←" : "→"}
					</div>
				</div>
			)}
		</div>
	);
}
