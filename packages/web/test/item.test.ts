import {describe, expect, it} from "vite-plus/test";
import {
	buildItemMenu,
	hasFooter,
	internalLinkUrl,
	itemMenuCommand,
	itemMenuLeft,
	localItemMenuAvailable,
} from "../src/client/item-menu-model.js";
import type {ItemMenuEntry} from "../src/client/item-menu-model.js";
import {qualifyItemMenu} from "../src/client/app-menu.js";
import {
	caretAfterArrowClear,
	commandTargets,
	contentMouseDownAction,
	deleteCaretTarget,
	dragRangeAt,
	editorSelectAllTakesOver,
	editorShiftArrowTakesOver,
	emptySelection,
	expand,
	isCovered,
	isEntry,
	leadId,
	pivotTo,
	removeIds,
	selectIds,
	selectMatchedIds,
	selectionMenuAnchor,
	selectionDeletePlan,
	selectionKeyAction,
	sortedIds,
	toggleClick,
} from "../src/client/item-selection.js";
import type {FlatRow, SelectionState, TreeView} from "../src/client/item-selection.js";

describe("item menu model", () => {
	const plain = {id: "alice", completedAt: null, isMirror: false};
	const everything = (): boolean => true;

	function tokens(entries: ItemMenuEntry[]): string {
		return entries
			.map((entry) => {
				if (entry.kind === "separator") {
					return "|";
				}
				return entry.kind === "submenu" ? `[${entry.id}]` : entry.id;
			})
			.join(" ")
			.replaceAll(/ ?\| ?/gu, " | ")
			.trim();
	}

	function menu(layoutMode: string | null, isMirror = false): string {
		return tokens(
			buildItemMenu({...plain, isMirror}, qualifyItemMenu({data: {layoutMode}}), localItemMenuAvailable),
		);
	}

	describe("buildItemMenu with local availability", () => {
		it("lists the plain bullet menu in the engine's order with group separators", () => {
			expect(menu(null)).toBe(
				"[node_type_picker] | open_in_pane complete add_note add_date present_it move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("shows the full upstream group order when everything is available", () => {
			expect(tokens(buildItemMenu(plain, qualifyItemMenu({data: {layoutMode: null}}), everything))).toBe(
				"[node_type_picker] | open_in_pane complete add_note add_date present_it comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("narrows a table cell to upstream's cell menu, with Delete column on the header row", () => {
			const cellMenu = (role: string) =>
				tokens(
					buildItemMenu(plain, qualifyItemMenu({data: {layoutMode: null}}, [role]), localItemMenuAvailable),
				);
			expect({header: cellMenu("is_table_header_cell"), body: cellMenu("is_table_body_cell")}).toStrictEqual({
				header: "[node_type_picker] | complete add_note add_date duplicate_table_column | delete_table_column",
				body: "[node_type_picker] | complete add_note add_date duplicate_table_column | delete",
			});
		});

		it("labels the column commands as upstream does", () => {
			expect([
				itemMenuCommand("duplicate_table_column", plain, everything)?.label,
				itemMenuCommand("delete_table_column", plain, everything)?.label,
			]).toStrictEqual(["Duplicate column", "Delete column"]);
		});

		it("narrows a divider to its active set", () => {
			expect(menu("divider")).toBe(
				"[node_type_picker] | move_to duplicate | copy_link | delete | expand_all collapse_all",
			);
		});

		it("drops add_date, present_it and make_template for code blocks", () => {
			expect(menu("code-block")).toBe(
				"[node_type_picker] | open_in_pane complete add_note move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("drops present_it and make_template for quote blocks", () => {
			expect(menu("quote-block")).toBe(
				"[node_type_picker] | open_in_pane complete add_note add_date move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
			);
		});

		it("reduces a dangling node to Delete", () => {
			expect(
				tokens(buildItemMenu(plain, qualifyItemMenu({isOriginalNotFound: true, data: {layoutMode: null}}))),
			).toBe("delete");
		});

		it("never lists delete_dates, even for a dated node", () => {
			expect(menu(null)).not.toContain("delete_dates");
		});

		it("offers Detach Mirror only for a mirror root", () => {
			const detach = (isMirror: boolean) =>
				tokens(
					buildItemMenu({...plain, isMirror}, qualifyItemMenu({data: {layoutMode: null}}), everything),
				).includes("detach_mirror");
			expect([detach(false), detach(true)]).toStrictEqual([false, true]);
		});
	});

	describe("itemMenuCommand", () => {
		it("labels complete as Uncomplete for a completed node", () => {
			expect(
				itemMenuCommand("complete", {completedAt: 1_700_000_000, isMirror: false}, everything),
			).toStrictEqual({
				key: "complete",
				label: "Uncomplete",
				icon: "check",
				shortcut: "⌘↵",
			});
		});

		it("returns null for unknown or unavailable commands", () => {
			expect([
				itemMenuCommand("ask_ai", plain, everything),
				itemMenuCommand("share", plain, () => false),
				itemMenuCommand("detach_mirror", plain, everything),
			]).toStrictEqual([null, null, null]);
		});

		it("uses the upstream shortcuts", () => {
			const ids = [
				"complete",
				"add_note",
				"add_date",
				"present_it",
				"comment",
				"move_to",
				"mirror",
				"duplicate",
				"copy_link",
				"delete",
				"expand_all",
			];
			expect(
				Object.fromEntries(
					ids.map((id) => [
						id,
						itemMenuCommand(id, {...plain, isMirror: true}, everything)?.shortcut ?? null,
					]),
				),
			).toStrictEqual({
				complete: "⌘↵",
				add_note: "⇧↵",
				add_date: "!!",
				present_it: "⇧⌘P",
				comment: "⌃M",
				move_to: "⌃⌘M",
				mirror: "⇧⌘M",
				duplicate: "⇧⌘D",
				copy_link: "⇧⌘L",
				delete: "⇧⌘⌫",
				expand_all: null,
			});
		});

		it("uses the upstream FA light icon names", () => {
			const ids = [
				"open_in_pane",
				"complete",
				"add_note",
				"add_date",
				"present_it",
				"comment",
				"move_to",
				"move_to_today",
				"move_to_tomorrow",
				"move_to_next_week",
				"move_to_date",
				"upload_file",
				"mirror_to",
				"mirror",
				"detach_mirror",
				"duplicate",
				"share",
				"show_export",
				"copy_link",
				"make_template",
				"delete",
				"expand_all",
				"collapse_all",
				"sort_children_asc",
				"sort_children_desc",
			];
			expect(
				Object.fromEntries(
					ids.map((id) => [id, itemMenuCommand(id, {...plain, isMirror: true}, everything)?.icon]),
				),
			).toStrictEqual({
				open_in_pane: "table-columns",
				complete: "check",
				add_note: "pencil",
				add_date: "calendar-days",
				present_it: "play",
				comment: "message-lines",
				move_to: "arrow-right-long",
				move_to_today: "calendar-day",
				move_to_tomorrow: "calendar-circle-plus",
				move_to_next_week: "calendar-week",
				move_to_date: "calendar-days",
				upload_file: "file",
				mirror_to: "diamond-turn-right",
				mirror: "diamond",
				detach_mirror: "xmark",
				duplicate: "copy",
				share: "user-group",
				show_export: "file-export",
				copy_link: "link",
				make_template: "puzzle-piece",
				delete: "trash-can",
				expand_all: "up-right-and-down-left-from-center",
				collapse_all: "down-left-and-up-right-to-center",
				sort_children_asc: "arrow-down-a-z",
				sort_children_desc: "arrow-down-z-a",
			});
		});
	});

	describe("hasFooter", () => {
		it("shows the footer only when the node has a modified time", () => {
			expect(hasFooter({modifiedAt: null})).toBe(false);
			expect(hasFooter({modifiedAt: 1_700_000_000})).toBe(true);
		});
	});

	describe("itemMenuLeft", () => {
		it("offsets the trigger by visible children and depth", () => {
			expect([
				itemMenuLeft(false, 0),
				itemMenuLeft(false, 3),
				itemMenuLeft(true, 1),
				itemMenuLeft(true, 2),
			]).toStrictEqual([
				"calc(var(--name-left-overhang) - 23px)",
				"calc(var(--name-left-overhang) - 23px)",
				"calc(var(--name-left-overhang) - 46px)",
				"calc(var(--name-left-overhang) - 55px)",
			]);
		});
	});

	describe("internalLinkUrl", () => {
		it("links to the last 12 hex digits of the id", () => {
			expect(internalLinkUrl("7aed376b-80c8-42c5-8065-ab03ee6d2ae0")).toBe(
				"https://workflowy.com/#/ab03ee6d2ae0",
			);
		});
	});

	describe("Detach Mirror in the bullet menu", () => {
		it("is listed between Mirror and Duplicate for a mirror and for an original that has mirrors, not for a plain row", () => {
			const rows = (node: {isMirror: boolean; hasMirrors: boolean}) =>
				tokens(
					buildItemMenu(
						{...plain, ...node},
						qualifyItemMenu({data: {layoutMode: null}}),
						localItemMenuAvailable,
					),
				)
					.split(" | ")[1]
					?.split(" ")
					.filter((id) => ["mirror_to", "mirror", "detach_mirror", "duplicate"].includes(id));
			expect([
				rows({isMirror: true, hasMirrors: false}),
				rows({isMirror: false, hasMirrors: true}),
				rows({isMirror: false, hasMirrors: false}),
			]).toStrictEqual([
				["mirror_to", "mirror", "detach_mirror", "duplicate"],
				["mirror_to", "mirror", "detach_mirror", "duplicate"],
				["mirror_to", "mirror", "duplicate"],
			]);
		});
	});
});

describe("item selection", () => {
	// R; Alpha{A1,A2}, Bravo, Charlie{C1}, Delta, Echo; all expanded.
	const children: Record<string, string[]> = {
		R: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"],
		Alpha: ["A1", "A2"],
		Charlie: ["C1"],
	};

	function fixtureTree(): TreeView {
		const parents = new Map<string, string>();
		for (const [parent, kids] of Object.entries(children)) {
			for (const kid of kids) {
				parents.set(kid, parent);
			}
		}
		const visibleOrder: string[] = ["R"];
		const walk = (id: string) => {
			for (const kid of children[id] ?? []) {
				visibleOrder.push(kid);
				walk(kid);
			}
		};
		walk("R");
		const sibling = (id: string, offset: number): string | null => {
			const parent = parents.get(id);
			if (parent === undefined) {
				return null;
			}
			const kids = children[parent] ?? [];
			return kids[kids.indexOf(id) + offset] ?? null;
		};
		return {
			zoomRootId: "R",
			parentOf: (id) => parents.get(id) ?? null,
			visibleOrder,
			nextPotentiallyVisibleSiblingOf: (id) => sibling(id, 1),
			previousPotentiallyVisibleSiblingOf: (id) => sibling(id, -1),
		};
	}

	const tree = fixtureTree();

	describe("expand", () => {
		it("walks the verified shift-arrow sequence from Bravo", () => {
			const steps: string[][] = [];
			let state: SelectionState = selectIds(emptySelection(), tree, ["Bravo"]);
			for (const dir of ["down", "down", "up", "up", "up", "up", "up", "down"] as const) {
				state = expand(state, tree, dir);
				steps.push(sortedIds(state, tree));
			}
			expect(steps).toStrictEqual([
				["Bravo", "Charlie"],
				["Bravo", "Charlie", "Delta"],
				["Bravo", "Charlie"],
				["Bravo"],
				["Alpha", "Bravo"],
				["R"],
				["R"],
				["Alpha", "Bravo"],
			]);
		});

		it("leaves an empty selection alone", () => {
			expect(expand(emptySelection(), tree, "down")).toStrictEqual(emptySelection());
		});

		it("never descends into children going down and stops at the zoom root's last row", () => {
			let state = selectIds(emptySelection(), tree, ["A2"]);
			const steps: string[][] = [];
			for (let i = 0; i < 5; i++) {
				state = expand(state, tree, "down");
				steps.push(sortedIds(state, tree));
			}
			expect(steps).toStrictEqual([
				["A2", "Bravo"],
				["A2", "Bravo", "Charlie"],
				["A2", "Bravo", "Charlie", "Delta"],
				["A2", "Bravo", "Charlie", "Delta", "Echo"],
				["A2", "Bravo", "Charlie", "Delta", "Echo"],
			]);
		});

		it("bumps the consecutive selected rows beyond the new row so the lead lands at the run's end", () => {
			const state = expand(selectIds(emptySelection(), tree, ["Delta", "Bravo"]), tree, "down");
			expect({sorted: sortedIds(state, tree), lead: leadId(state)}).toStrictEqual({
				sorted: ["Bravo", "Charlie", "Delta"],
				lead: "Delta",
			});
		});
	});

	describe("toggleClick", () => {
		it("adds non-contiguous rows and removes the covering ancestor", () => {
			const alpha = toggleClick(emptySelection(), tree, "Alpha");
			const alphaDelta = toggleClick(alpha, tree, "Delta");
			const delta = toggleClick(alphaDelta, tree, "A1");
			expect([sortedIds(alphaDelta, tree), sortedIds(delta, tree)]).toStrictEqual([
				["Alpha", "Delta"],
				["Delta"],
			]);
		});
	});

	describe("pivotTo", () => {
		it("selects the walked range from the focused row and retracts it on the next shift-click", () => {
			const toDelta = pivotTo(emptySelection(), tree, "Delta", "Bravo");
			const toA1 = pivotTo(toDelta, tree, "A1", "Bravo");
			expect([sortedIds(toDelta, tree), sortedIds(toA1, tree)]).toStrictEqual([
				["Bravo", "Charlie", "Delta"],
				["A1", "A2", "Bravo"],
			]);
		});

		it("falls back to the zoom root's first child with no pivot, lead or focus", () => {
			expect(sortedIds(pivotTo(emptySelection(), tree, "Bravo", null), tree)).toStrictEqual(["Alpha", "Bravo"]);
		});

		it("steps into the clicked row's ancestor instead of skipping past it", () => {
			expect(sortedIds(pivotTo(emptySelection(), tree, "C1", "Alpha"), tree)).toStrictEqual([
				"Alpha",
				"Bravo",
				"Charlie",
			]);
		});
	});

	describe("selectIds", () => {
		it("subsumes selected descendants when an ancestor is selected", () => {
			const state = selectIds(selectIds(emptySelection(), tree, ["A1"]), tree, ["R"]);
			expect(state.entries).toStrictEqual([{id: "R", leadOrder: 2, subsumedIds: ["A1"]}]);
		});

		it("skips covered and unknown ids", () => {
			const state = selectIds(selectIds(emptySelection(), tree, ["Alpha"]), tree, ["A1", "Nope", "Alpha"]);
			expect(state.entries).toStrictEqual([{id: "Alpha", leadOrder: 1, subsumedIds: []}]);
		});
	});

	describe("removeIds", () => {
		it("drops entries and clears a removed pivot", () => {
			const state = removeIds(toggleClick(toggleClick(emptySelection(), tree, "Bravo"), tree, "Delta"), [
				"Delta",
			]);
			expect(state).toStrictEqual({
				entries: [{id: "Bravo", leadOrder: 1, subsumedIds: []}],
				pivotId: null,
				retractableIds: [],
				counter: 2,
			});
		});
	});

	describe("isCovered", () => {
		it("is true for a selected row and its descendants only", () => {
			const state = selectIds(emptySelection(), tree, ["Alpha"]);
			expect(["Alpha", "A2", "Bravo"].map((id) => isCovered(state, tree, id))).toStrictEqual([true, true, false]);
		});
	});

	describe("isEntry", () => {
		it("marks only the selected entries; descendants are covered by the entry's nested .project", () => {
			const state = selectIds(emptySelection(), tree, ["Charlie", "Echo"]);
			expect(["Charlie", "C1", "Delta", "Echo"].map((id) => isEntry(state, id))).toStrictEqual([
				true,
				false,
				false,
				true,
			]);
		});
	});

	// The navigable rows in display order: the zoom root's title, then every visible row.
	const flattened: FlatRow[] = tree.visibleOrder.map((id) => ({id, parentId: id === "R" ? null : tree.parentOf(id)}));

	describe("editorShiftArrowTakesOver", () => {
		it("takes over only at the caret boundary of the name editor", () => {
			expect([
				editorShiftArrowTakesOver({dir: "down", start: 2, end: 3, length: 5, inNote: false}),
				editorShiftArrowTakesOver({dir: "down", start: 2, end: 5, length: 5, inNote: false}),
				editorShiftArrowTakesOver({dir: "up", start: 0, end: 3, length: 5, inNote: false}),
				editorShiftArrowTakesOver({dir: "up", start: 1, end: 5, length: 5, inNote: false}),
				editorShiftArrowTakesOver({dir: "up", start: 0, end: 0, length: 5, inNote: true}),
			]).toStrictEqual([false, true, true, false, false]);
		});
	});

	describe("editorSelectAllTakesOver", () => {
		it("takes over once the whole row text is already selected", () => {
			expect([
				editorSelectAllTakesOver({start: 0, end: 5, length: 5}),
				editorSelectAllTakesOver({start: 1, end: 5, length: 5}),
				editorSelectAllTakesOver({start: 0, end: 4, length: 5}),
				editorSelectAllTakesOver({start: 0, end: 0, length: 0}),
			]).toStrictEqual([true, false, false, true]);
		});
	});

	describe("caretAfterArrowClear", () => {
		it("places the caret beside the selection for each arrow", () => {
			expect([
				caretAfterArrowClear("down", ["Alpha", "Bravo"], flattened),
				caretAfterArrowClear("up", ["Bravo"], flattened),
				caretAfterArrowClear("right", ["Alpha"], flattened),
				caretAfterArrowClear("left", ["Bravo", "Delta"], flattened),
				caretAfterArrowClear("down", ["Alpha"], flattened),
			]).toStrictEqual([
				{id: "Charlie", offset: 0},
				{id: "A2", offset: 0},
				{id: "A2", offset: "end"},
				{id: "Bravo", offset: 0},
				{id: "Bravo", offset: 0},
			]);
		});

		it("falls back to the selection's own rows at the outline's edges", () => {
			expect([
				caretAfterArrowClear("down", ["Echo"], flattened),
				caretAfterArrowClear("up", ["R"], flattened),
				caretAfterArrowClear("down", ["R"], flattened),
				caretAfterArrowClear("left", [], flattened),
			]).toStrictEqual([{id: "Echo", offset: "end"}, {id: "R", offset: 0}, {id: "Echo", offset: "end"}, null]);
		});
	});

	describe("deleteCaretTarget", () => {
		it("is the end of the row above the first selected row", () => {
			expect([
				deleteCaretTarget(["Echo"], flattened),
				deleteCaretTarget(["Charlie", "Echo"], flattened),
				deleteCaretTarget(["A1"], flattened),
			]).toStrictEqual([
				{id: "Delta", offset: "end"},
				{id: "Bravo", offset: "end"},
				{id: "Alpha", offset: "end"},
			]);
		});

		it("falls back to the start of the row after the selection, else nowhere", () => {
			const rows = flattened.slice(1);
			expect([
				deleteCaretTarget(["Alpha"], rows),
				deleteCaretTarget(["Alpha", "Bravo", "Charlie", "Delta", "Echo"], rows),
			]).toStrictEqual([{id: "Bravo", offset: 0}, null]);
		});
	});

	describe("selectionDeletePlan", () => {
		it("zooms out to the zoom root's parent when the zoom root itself is deleted, as upstream's np does", () => {
			const parentOf = (id: string) => ({Alpha: "R", R: null})[id] ?? null;
			expect([
				selectionDeletePlan(["Alpha"], flattened, "Alpha", parentOf),
				selectionDeletePlan(["R"], flattened, "R", parentOf),
			]).toStrictEqual([
				{kind: "zoom-out", parentId: "R"},
				{kind: "zoom-out", parentId: null},
			]);
		});

		it("edits beside the deleted rows otherwise", () => {
			expect(selectionDeletePlan(["Charlie", "Echo"], flattened, "R", () => null)).toStrictEqual({
				kind: "edit-beside",
				target: {id: "Bravo", offset: "end"},
			});
		});
	});

	describe("selectionKeyAction", () => {
		const key = (
			k: string,
			mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
		) => ({
			key: k,
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			...mods,
		});

		it("maps the keys a selection owns on mac", () => {
			expect(
				[
					key("ArrowUp", {shiftKey: true}),
					key("ArrowDown", {shiftKey: true}),
					key("a", {metaKey: true}),
					key("a", {ctrlKey: true}),
					key("ArrowLeft"),
					key("ArrowRight"),
					key("ArrowUp"),
					key("ArrowDown"),
					key("Backspace"),
					key("Delete"),
					key("Escape"),
					key("ArrowUp", {metaKey: true, shiftKey: true}),
					key("x"),
				].map((event) => selectionKeyAction(event, true)),
			).toStrictEqual([
				"EXPAND_UP",
				"EXPAND_DOWN",
				"SELECT_ALL",
				null,
				"CLEAR_LEFT",
				"CLEAR_RIGHT",
				"CLEAR_UP",
				"CLEAR_DOWN",
				"DELETE",
				"DELETE",
				null,
				null,
				null,
			]);
		});

		it("selects all with ctrl elsewhere", () => {
			expect([
				selectionKeyAction(key("a", {ctrlKey: true}), false),
				selectionKeyAction(key("a", {metaKey: true}), false),
			]).toStrictEqual(["SELECT_ALL", null]);
		});
	});

	describe("dragRangeAt", () => {
		const row = (id: string, top: number, height = 28, parentId: string | null = null) => ({
			id,
			top,
			height,
			parentId,
		});
		const rows = [
			row("Alpha", 0),
			row("A1", 28, 28, "Alpha"),
			row("A2", 56, 28, "Alpha"),
			row("Bravo", 84),
			row("Charlie", 112, 56),
			row("C1", 140, 28, "Charlie"),
			row("Delta", 168),
			row("Echo", 196),
		];
		const startName = {top: 84, height: 28};
		const at = (y: number) => dragRangeAt(rows, 3, startName, y);

		it("returns null inside the dead zone around the start name", () => {
			expect([at(112), at(116)]).toStrictEqual([null, null]);
		});

		it("steps back a row near a row top below the start, as upstream does", () => {
			expect([at(117), at(125), at(126), at(172), at(173)]).toStrictEqual([
				["Bravo"],
				["Bravo"],
				["Bravo", "Charlie"],
				["Bravo", "Charlie"],
				["Bravo", "Charlie", "Delta"],
			]);
		});

		it("selects upward rows and drops rows whose parent is in range", () => {
			expect([at(74), at(30)]).toStrictEqual([["Bravo"], ["A1", "A2", "Bravo"]]);
		});
	});

	describe("contentMouseDownAction", () => {
		const press = (
			mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
			extra: Partial<{button: number; onBullet: boolean; isEditingRow: boolean}> = {},
		) => ({
			button: 0,
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			onBullet: false,
			isEditingRow: false,
			...mods,
			...extra,
		});

		it("toggles on ⌘/⌥, pivots on ⇧ off the edited row, and arms a drag on a plain left press", () => {
			expect(
				[
					press({metaKey: true}),
					press({altKey: true}),
					press({ctrlKey: true}),
					press({shiftKey: true}),
					press({shiftKey: true}, {isEditingRow: true}),
					press(),
					press({}, {isEditingRow: true}),
					press({}, {button: 2}),
					press({metaKey: true}, {onBullet: true}),
				].map((event) => contentMouseDownAction(event, true)),
			).toStrictEqual(["TOGGLE", "TOGGLE", null, "PIVOT", null, "DRAG", "DRAG", null, null]);
		});

		it("toggles with ctrl elsewhere", () => {
			expect([
				contentMouseDownAction(press({ctrlKey: true}), false),
				contentMouseDownAction(press({metaKey: true}), false),
			]).toStrictEqual(["TOGGLE", null]);
		});
	});

	describe("commandTargets", () => {
		it("returns the selection in display order", () => {
			const state = selectIds(emptySelection(), tree, ["Bravo", "Alpha"]);
			expect(commandTargets(state, () => tree, "Charlie")).toStrictEqual(["Alpha", "Bravo"]);
		});

		it("falls back to the edited row without a selection", () => {
			expect(commandTargets(emptySelection(), () => tree, "alice")).toStrictEqual(["alice"]);
		});

		it("is empty with neither a selection nor an edited row", () => {
			expect(commandTargets(emptySelection(), () => tree, null)).toStrictEqual([]);
		});
	});

	describe("selectionMenuAnchor", () => {
		const delta = (id: string) => id !== "never";
		const picked = selectIds(selectIds(emptySelection(), fixtureTree(), ["Delta"]), fixtureTree(), ["Alpha"]);

		it("anchors on the last inserted entry and counts every entry", () => {
			expect(selectionMenuAnchor(picked, delta)).toStrictEqual({anchorId: "Alpha", count: 2});
		});

		it("falls back to the previous entry when the last one has no rendered row", () => {
			expect(selectionMenuAnchor(picked, (id) => id !== "Alpha")).toStrictEqual({anchorId: "Delta", count: 2});
		});

		it("has no anchor when nothing is rendered, but still counts", () => {
			expect(selectionMenuAnchor(picked, () => false)).toStrictEqual({anchorId: null, count: 2});
		});

		it("is empty for an empty selection", () => {
			expect(selectionMenuAnchor(emptySelection(), delta)).toStrictEqual({anchorId: null, count: 0});
		});
	});

	describe("selectMatchedIds", () => {
		const rows = [
			{id: "Alpha", matches: true, completed: false, isMirror: false},
			{id: "A1", matches: true, completed: true, isMirror: false},
			{id: "Bravo", matches: false, completed: false, isMirror: false},
			{id: "B1", matches: true, completed: false, isMirror: true},
			{id: "Charlie", matches: true, completed: false, isMirror: false},
		];

		it("drops completed matches when completed are hidden", () => {
			expect(selectMatchedIds(rows, {showCompleted: false, includeMirrors: true})).toStrictEqual([
				"Alpha",
				"B1",
				"Charlie",
			]);
		});

		it("drops mirror matches when mirrors are excluded", () => {
			expect(selectMatchedIds(rows, {showCompleted: true, includeMirrors: false})).toStrictEqual([
				"Alpha",
				"A1",
				"Charlie",
			]);
		});

		it("collapses matched descendants under matched ancestors", () => {
			const state = selectIds(emptySelection(), tree, ["Alpha", "A1", "Charlie"]);
			expect({ids: sortedIds(state, tree), entryIds: state.entries.map((entry) => entry.id)}).toStrictEqual({
				ids: ["Alpha", "Charlie"],
				entryIds: ["Alpha", "Charlie"],
			});
		});

		it("records the descendant as subsumed when it was selected first", () => {
			const state = selectIds(emptySelection(), tree, ["A1", "Alpha", "Charlie"]);
			expect(state.entries[0]?.subsumedIds).toStrictEqual(["A1"]);
		});

		it("is empty with no matches", () => {
			expect(selectMatchedIds([], {showCompleted: true, includeMirrors: true})).toStrictEqual([]);
		});
	});
});
