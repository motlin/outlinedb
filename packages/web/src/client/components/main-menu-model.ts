import {isValidElement} from "react";
import type {ReactElement, ReactNode} from "react";
import type {FaIconKey} from "./fa-icons.js";

/** A compacted header or pane action prepended to the menu, like upstream's `more-menu.menu.header.*`. */
export interface GearMenuHeaderItem {
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	disabled?: boolean;
	handbook?: string;
}

/** Upstream's `gui-more-menu.groups.header` list, verbatim from the live config. */
export const MAIN_MENU_GROUPS = [
	"header.move-pane-left",
	"header.move-pane-right",
	"------------",
	"edit.undo",
	"edit.redo",
	"------------",
	"view.expand-all",
	"view.collapse-all",
	"------------",
	"view.export",
	"view.print",
	"------------",
	"desktop.desktop-new-version",
	"desktop.desktop-pin-as-top-window",
	"------------",
	"edu.faculty-dashboard",
	"show.show-settings-dialog",
	"------------",
	"changelog.download-apps",
	"promote.zapier",
	"------------",
	"workflowy.help",
	"------------",
	"auth.log-out",
	"------------",
	"status.autosave",
] as const;

/** The Help submenu's groups, verbatim from the live config. */
export const HELP_SUBMENU_GROUPS = [
	"changelog.show",
	"changelog.learn",
	"show.show-help-dialog",
	"show.report-problem",
	"workflowy.community",
	"workflowy.blog",
] as const;

const SEPARATOR = "------------";

export interface MenuRowEntry {
	label: string;
	icon?: FaIconKey | ReactElement | undefined;
	shortcut?: string | undefined;
	subtext?: string | undefined;
	handbook?: string | undefined;
	disabled?: boolean | undefined;
	hidden?: boolean | undefined;
	extra?: "chevron-down" | undefined;
	/** Upstream's blue dot: Help and What's New while a changelog entry is unread. */
	blueDot?: boolean | undefined;
	onSelect?: (() => unknown) | undefined;
}

export type MainMenuEntry = MenuRowEntry | {component: "autosave"};

export type MenuRow = {separator: true; before: string} | {key: string; entry: MainMenuEntry};

function isHidden(entry: MainMenuEntry): boolean {
	return "hidden" in entry && entry.hidden === true;
}

/**
 * Upstream renderer `O92`: a separator key only arms a pending separator once a row has been emitted, and is
 * emitted right before the next visible row, so leading, trailing and doubled separators never appear.
 */
export function buildMenuRows(groups: readonly string[], entries: Readonly<Record<string, MainMenuEntry>>): MenuRow[] {
	const rows: MenuRow[] = [];
	let pending = false;
	for (const key of groups) {
		if (key === SEPARATOR) {
			pending = rows.length > 0;
			continue;
		}
		const entry = entries[key];
		if (!entry || isHidden(entry)) {
			continue;
		}
		if (pending) {
			rows.push({separator: true, before: key});
			pending = false;
		}
		rows.push({key, entry});
	}
	return rows;
}

export interface MainMenuActions {
	undo: () => void;
	redo: () => void;
	expandAll: () => void;
	collapseAll: () => void;
	exportZoomed: () => void;
	print: () => void;
	openSettings: () => void;
	openUrl: (url: string) => void;
	/** Opens the Help submenu. */
	openHelp: () => void;
}

export interface MainMenuContext {
	canUndo: boolean;
	canRedo: boolean;
	/** What's New has unread entries, which dots the Help row (upstream `blueDotFrom: "changelog.show"`). */
	changelogUnread?: boolean;
	paneRows: readonly GearMenuHeaderItem[];
	actions: MainMenuActions;
}

/** A header or pane action as a menu entry; only element icons carry over (the rows are not FontAwesome keys). */
export function entryFromItem(item: GearMenuHeaderItem): MenuRowEntry {
	return {
		label: item.label,
		icon: isValidElement(item.icon) ? item.icon : undefined,
		disabled: item.disabled,
		handbook: item.handbook,
		onSelect: item.onSelect,
	};
}

const PRINT_DELAY_MS = 100;

const GET_THE_APPS_URL = "https://workflowy.com/download";
const LEARN_URL = "https://workflowy.com/help/get-started";
const COMMUNITY_URL = "https://community.workflowy.com/";
const BLOG_URL = "https://blog.workflowy.com/";

/**
 * The main menu's entries by upstream key. Rows with no local meaning are hidden the way upstream hides them:
 * desktop rows, Faculty dashboard, Log out (no account) and Zapier (deliberately omitted).
 */
export function mainMenuEntries({
	canUndo,
	canRedo,
	changelogUnread = false,
	paneRows,
	actions,
}: MainMenuContext): Record<string, MainMenuEntry> {
	const entries: Record<string, MainMenuEntry> = {
		"edit.undo": {
			label: "Undo",
			icon: "fal:arrow-rotate-left",
			shortcut: "⌘Z",
			handbook: "undo.undo",
			disabled: !canUndo,
			onSelect: actions.undo,
		},
		"edit.redo": {
			label: "Redo",
			icon: "fal:arrow-rotate-right",
			shortcut: "⇧⌘Z",
			handbook: "undo.redo",
			disabled: !canRedo,
			onSelect: actions.redo,
		},
		"view.expand-all": {
			label: "Expand all",
			icon: "fal:up-right-and-down-left-from-center",
			handbook: "expand.toggle",
			onSelect: actions.expandAll,
		},
		"view.collapse-all": {
			label: "Collapse all",
			icon: "fal:down-left-and-up-right-to-center",
			handbook: "expand.toggle",
			onSelect: actions.collapseAll,
		},
		"view.export": {label: "Export", icon: "fal:file-export", onSelect: actions.exportZoomed},
		"view.print": {
			label: "Print",
			icon: "fal:print",
			shortcut: "⌘P",
			handbook: "print.print",
			onSelect: () => {
				setTimeout(actions.print, PRINT_DELAY_MS);
			},
		},
		"desktop.desktop-new-version": {label: "Update desktop app", hidden: true},
		"desktop.desktop-pin-as-top-window": {label: "Pin as top window", hidden: true},
		"edu.faculty-dashboard": {label: "Faculty dashboard", hidden: true},
		"show.show-settings-dialog": {
			label: "Settings",
			icon: "fal:gear",
			handbook: "settings.show",
			onSelect: actions.openSettings,
		},
		"changelog.download-apps": {
			label: "Get the Apps",
			icon: "fal:download",
			onSelect: () => {
				actions.openUrl(GET_THE_APPS_URL);
			},
		},
		"promote.zapier": {label: "Integrations", icon: "fal:bolt", handbook: "integrate.integrate", hidden: true},
		"workflowy.help": {
			label: "Help",
			icon: "fal:circle-question",
			extra: "chevron-down",
			blueDot: changelogUnread,
			onSelect: actions.openHelp,
		},
		"auth.log-out": {label: "Log out", icon: "fal:arrow-right-from-bracket", hidden: true},
		"status.autosave": {component: "autosave"},
	};
	const [left, right] = paneRows;
	for (const [key, item] of [
		["header.move-pane-left", left],
		["header.move-pane-right", right],
	] as const) {
		if (item) {
			entries[key] = entryFromItem(item);
		}
	}
	return entries;
}

/** The Help submenu's entries by upstream key; no row has an icon. */
export function helpEntries({
	hasHelpDialog,
	changelogUnread,
	openChangelog,
	openUrl,
}: {
	hasHelpDialog: boolean;
	/** Some What's New entry is unread: the row gets upstream's blue dot. */
	changelogUnread: boolean;
	openChangelog: () => void;
	openUrl: (url: string) => void;
}): Record<string, MainMenuEntry> {
	const link = (url: string) => () => {
		openUrl(url);
	};
	return {
		"changelog.show": {label: "What's New", blueDot: changelogUnread, onSelect: openChangelog},
		"changelog.learn": {label: "Learn WorkFlowy", onSelect: link(LEARN_URL)},
		"show.show-help-dialog": {label: "Help", handbook: "help.show", hidden: !hasHelpDialog},
		"show.report-problem": {label: "Report a problem", handbook: "bug.report", hidden: true},
		"workflowy.community": {label: "Community", onSelect: link(COMMUNITY_URL)},
		"workflowy.blog": {label: "Blog", onSelect: link(BLOG_URL)},
	};
}
