import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {
	HELP_SUBMENU_GROUPS,
	MAIN_MENU_GROUPS,
	buildMenuRows,
	helpEntries,
	mainMenuEntries,
} from "../src/client/components/main-menu-model.js";
import type {MainMenuActions, MainMenuEntry, MenuRow} from "../src/client/components/main-menu-model.js";

function spies() {
	return {
		undo: vi.fn<() => void>(),
		redo: vi.fn<() => void>(),
		expandAll: vi.fn<() => void>(),
		collapseAll: vi.fn<() => void>(),
		exportZoomed: vi.fn<() => void>(),
		print: vi.fn<() => void>(),
		openSettings: vi.fn<() => void>(),
		openUrl: vi.fn<(url: string) => void>(),
		openHelp: vi.fn<() => void>(),
	} satisfies MainMenuActions;
}

/** Runs the entry's `onSelect`, failing when the key has no selectable entry. */
function select(entries: Record<string, MainMenuEntry>, key: string): void {
	const entry = entries[key];
	if (!("onSelect" in entry) || entry.onSelect === undefined) {
		throw new Error(`no selectable entry for ${key}`);
	}
	entry.onSelect();
}

function names(rows: MenuRow[]): string[] {
	return rows.map((row) => {
		if ("separator" in row) {
			return "---";
		}
		return "component" in row.entry ? "autosave" : row.entry.label;
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("buildMenuRows", () => {
	it("lays out the local main menu with upstream's separators", () => {
		const rows = buildMenuRows(
			MAIN_MENU_GROUPS,
			mainMenuEntries({canUndo: false, canRedo: false, paneRows: [], actions: spies()}),
		);
		expect(names(rows)).toStrictEqual([
			"Undo",
			"Redo",
			"---",
			"Expand all",
			"Collapse all",
			"---",
			"Export",
			"Print",
			"---",
			"Settings",
			"---",
			"Get the Apps",
			"---",
			"Help",
			"---",
			"autosave",
		]);
	});

	it("never emits leading, trailing or doubled separators", () => {
		const entries = {a: {label: "A"}, b: {label: "B"}, gone: {label: "Gone", hidden: true}};
		expect(
			names(buildMenuRows(["------------", "a", "------------", "------------", "b", "------------"], entries)),
		).toStrictEqual(["A", "---", "B"]);
		expect(names(buildMenuRows(["------------", "gone", "------------", "missing"], entries))).toStrictEqual([]);
	});

	it("puts the pane rows first, followed by a separator", () => {
		const paneRows = [
			{label: "Move pane left", icon: "L", onSelect: vi.fn<() => void>()},
			{label: "Move pane right", icon: "R", onSelect: vi.fn<() => void>()},
		];
		const rows = buildMenuRows(
			MAIN_MENU_GROUPS,
			mainMenuEntries({canUndo: false, canRedo: false, paneRows, actions: spies()}),
		);
		expect(names(rows).slice(0, 4)).toStrictEqual(["Move pane left", "Move pane right", "---", "Undo"]);
	});
});

describe("mainMenuEntries", () => {
	it("describes Undo as upstream does", () => {
		const actions = spies();
		const entries = mainMenuEntries({canUndo: false, canRedo: true, paneRows: [], actions});
		expect(entries["edit.undo"]).toStrictEqual({
			label: "Undo",
			icon: "fal:arrow-rotate-left",
			shortcut: "⌘Z",
			handbook: "undo.undo",
			disabled: true,
			onSelect: actions.undo,
		});
		expect(entries["edit.redo"]).toMatchObject({disabled: false, handbook: "undo.redo"});
	});

	it("exports the zoomed item through the export action", () => {
		const actions = spies();
		const entries = mainMenuEntries({canUndo: false, canRedo: false, paneRows: [], actions});
		expect(entries["view.export"]).toMatchObject({label: "Export", icon: "fal:file-export"});
		select(entries, "view.export");
		expect(actions.exportZoomed).toHaveBeenCalledOnce();
	});

	it("defers Print by 100ms", () => {
		vi.useFakeTimers();
		const actions = spies();
		const entries = mainMenuEntries({canUndo: false, canRedo: false, paneRows: [], actions});
		select(entries, "view.print");
		vi.advanceTimersByTime(99);
		expect(actions.print).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(actions.print).toHaveBeenCalledOnce();
	});

	it("opens the download page from Get the Apps", () => {
		const actions = spies();
		const entries = mainMenuEntries({canUndo: false, canRedo: false, paneRows: [], actions});
		select(entries, "changelog.download-apps");
		expect(actions.openUrl.mock.calls).toStrictEqual([["https://workflowy.com/download"]]);
	});
});

function helpOptions(overrides: Partial<Parameters<typeof helpEntries>[0]> = {}): Parameters<typeof helpEntries>[0] {
	return {
		hasHelpDialog: false,
		changelogUnread: false,
		openChangelog: vi.fn<() => void>(),
		openUrl: vi.fn<(url: string) => void>(),
		...overrides,
	};
}

describe("Help submenu rows", () => {
	it("lists What's New first and omits Report a problem and the Help dialog while it does not exist", () => {
		const entries = helpEntries(helpOptions());
		expect(names(buildMenuRows(HELP_SUBMENU_GROUPS, entries))).toStrictEqual([
			"What's New",
			"Learn workflowy.com",
			"Community",
			"Blog",
		]);
	});

	it("shows Help between Learn workflowy.com and Community once the dialog exists", () => {
		const entries = helpEntries(helpOptions({hasHelpDialog: true}));
		expect(names(buildMenuRows(HELP_SUBMENU_GROUPS, entries))).toStrictEqual([
			"What's New",
			"Learn workflowy.com",
			"Help",
			"Community",
			"Blog",
		]);
	});

	it("gives What's New upstream's blue dot while an entry is unread, and opens the changelog", () => {
		const openChangelog = vi.fn<() => void>();
		const unread = helpEntries(helpOptions({changelogUnread: true, openChangelog}));
		const read = helpEntries(helpOptions({openChangelog}));
		select(unread, "changelog.show");
		expect({
			unread: unread["changelog.show"],
			read: read["changelog.show"],
			opened: openChangelog.mock.calls.length,
		}).toStrictEqual({
			unread: {label: "What's New", blueDot: true, onSelect: openChangelog},
			read: {label: "What's New", blueDot: false, onSelect: openChangelog},
			opened: 1,
		});
	});

	it("opens the upstream links", () => {
		const openUrl = vi.fn<(url: string) => void>();
		const entries = helpEntries(helpOptions({openUrl}));
		for (const key of ["changelog.learn", "workflowy.community", "workflowy.blog"]) {
			select(entries, key);
		}
		expect(openUrl.mock.calls).toStrictEqual([
			["https://workflowy.com/help/get-started"],
			["https://community.workflowy.com/"],
			["https://blog.workflowy.com/"],
		]);
	});
});

describe("Help row blue dot (upstream blueDotFrom changelog.show)", () => {
	it("dots the main menu's Help row only while What's New has unread entries", () => {
		const help = (changelogUnread: boolean) => {
			const entry = mainMenuEntries({
				canUndo: false,
				canRedo: false,
				paneRows: [],
				changelogUnread,
				actions: spies(),
			})["workflowy.help"];
			return "blueDot" in entry ? entry.blueDot : undefined;
		};
		expect([help(true), help(false)]).toStrictEqual([true, false]);
	});
});
