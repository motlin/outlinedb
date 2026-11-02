// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {goToNode, stepNav, zoomToCachedLocation} from "../src/client/navigation.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {focusScrolls} from "../src/client/quiet-focus.js";
import {oweViewRestore, viewStates} from "../src/client/view-state.js";
import {restoreViewAfterSwap} from "../src/client/view-restore.js";

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";

let frames: FrameRequestCallback[] = [];

beforeEach(() =>
{
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() =>
{
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

/** Mounts the row `nodeId` as the new view shows it. */
function mountRow(nodeId: string, text = "row", className = "innerContentContainer"): HTMLElement
{
	const row = document.createElement("div");
	row.className = className;
	row.setAttribute("data-node-id", nodeId);
	row.textContent = text;
	document.body.append(row);
	return row;
}

async function paint(): Promise<void>
{
	for (const frame of frames.splice(0))
	{
		frame(0);
	}
	await new Promise((resolve) =>
	{
		setTimeout(resolve, 5);
	});
}

describe("navigation while editing", () =>
{
	it("goToNode swaps with no row editing and resumes the edited row after the paint", async () =>
	{
		mountRow(BOB);
		useOutlineStore.getState().resumeEditing(BOB, 3);
		goToNode(() => {}, ALICE);
		const atSwap = useOutlineStore.getState().editingId;
		await paint();
		const {editingId, editingCaretOffset} = useOutlineStore.getState();
		expect(
			{
				atSwap,
				editingId,
				editingCaretOffset,
			},
		).toStrictEqual(
			{
				atSwap: null,
				editingId: BOB,
				editingCaretOffset: 3,
			},
		);
	});

	it("Back zooms from the popstate with no row editing and resumes the edited row after the paint", async () =>
	{
		mountRow(BOB);
		useOutlineStore.getState().resumeEditing(BOB, 2);
		zoomToCachedLocation("#/aaaaaaaaaaaa", (id) => (id === "aaaaaaaaaaaa" ? ALICE : undefined));
		const atSwap = useOutlineStore.getState().editingId;
		await paint();
		expect(
			{
				atSwap,
				editingId: useOutlineStore.getState().editingId,
			},
		).toStrictEqual(
			{
				atSwap: null,
				editingId: BOB,
			},
		);
	});

	it("resumes the edited row after a swap without scrolling to it, as upstream keeps the restored scroll", async () =>
	{
		mountRow(BOB);
		useOutlineStore.getState().resumeEditing(BOB, 2);
		zoomToCachedLocation("#/aaaaaaaaaaaa", (id) => (id === "aaaaaaaaaaaa" ? ALICE : undefined));
		await paint();
		expect(
			{
				resumed: focusScrolls(BOB),
				later: focusScrolls(BOB),
			},
		).toStrictEqual(
			{
				resumed: false,
				later: true,
			},
		);
	});
});

describe("editing across a zoom swap", () =>
{
	it("stops editing a row the new view does not show", async () =>
	{
		useOutlineStore.getState().resumeEditing(BOB, 3);
		goToNode(() => {}, ALICE);
		await paint();
		expect(useOutlineStore.getState().editingId).toBeNull();
	});
});

describe("capturing the view on leave", () =>
{
	afterEach(() =>
	{
		document.body.replaceChildren();
		viewStates.clear();
	});

	it("saves a reversed name range and the scroll under the location left", () =>
	{
		const row = mountRow(BOB, "hello world", "innerContentContainer editing");
		const text = row.firstChild as Text;
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					back: [],
					forward: [],
				},
			},
		);
		useOutlineStore.getState().resumeEditing(BOB, 1);
		getSelection()?.setBaseAndExtent(text, 4, text, 1);
		vi.stubGlobal("scrollY", 120);
		useOutlineStore.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "bbbbbbbbbbbb",
					query: null,
				},
			},
		);
		expect(viewStates.get("aaaaaaaaaaaa?")).toStrictEqual(
			{
				editing:
				{
					nodeId: BOB,
					field: "name",
					start: 1,
					end: 4,
					reversed: true,
				},
				scrollY: 120,
			},
		);
	});

	it("saves a note caret as the note field", () =>
	{
		const note = mountRow(BOB, "a note", "notes");
		note.className = "notes";
		const content = document.createElement("div");
		content.className = "content active";
		const inner = document.createElement("div");
		inner.className = "innerContentContainer";
		inner.textContent = "a note";
		content.append(inner);
		note.replaceChildren(content);
		const text = inner.firstChild as Text;
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: "q",
					},
					back: [],
					forward: [],
				},
			},
		);
		useOutlineStore.getState().focusNote(BOB, 2);
		getSelection()?.setBaseAndExtent(text, 2, text, 2);
		vi.stubGlobal("scrollY", 0);
		useOutlineStore.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "bbbbbbbbbbbb",
					query: null,
				},
			},
		);
		expect(viewStates.get("aaaaaaaaaaaa?q")).toStrictEqual(
			{
				editing:
				{
					nodeId: BOB,
					field: "note",
					start: 2,
					end: 2,
					reversed: false,
				},
				scrollY: 0,
			},
		);
	});

	it("saves nothing while a zoom animation runs", () =>
	{
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					back: [],
					forward: [],
				},
			},
		);
		document.body.classList.add("item--zooming-in-progress");
		useOutlineStore.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "bbbbbbbbbbbb",
					query: null,
				},
			},
		);
		document.body.classList.remove("item--zooming-in-progress");
		expect(viewStates.size).toBe(0);
	});
});

describe("restoring the view after a swap", () =>
{
	const ROW_20 = "20202020-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
	const C1 = "c1c1c1c1-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
	const C2 = "c2c2c2c2-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
	const scrolls: number[] = [];

	beforeEach(() =>
	{
		scrolls.length = 0;
		vi.stubGlobal("scrollTo", (_x: number, y: number) => scrolls.push(y));
		vi.stubGlobal("scrollY", 0);
	});

	afterEach(() =>
	{
		viewStates.clear();
	});

	it("Back refocuses the saved reversed range, restores the scroll and clears the selection", async () =>
	{
		viewStates.set(
			"aaaaaaaaaaaa?",
			{
				editing:
				{
					nodeId: ROW_20,
					field: "name",
					start: 1,
					end: 4,
					reversed: true,
				},
				scrollY: 500,
			},
		);
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "bbbbbbbbbbbb",
						query: null,
					},
					back: [
						{
							id: "aaaaaaaaaaaa",
							query: null,
						},
					],
					forward: [],
				},
			},
		);
		stepNav(
			() => {},
			"back",
			() => {},
		);
		const row = mountRow(ROW_20, "hello world", "innerContentContainer editing");
		restoreViewAfterSwap(ALICE, [ALICE, ROW_20]);
		await paint();
		const selection = getSelection();
		expect(
			{
				editingId: useOutlineStore.getState().editingId,
				anchor: [selection?.anchorNode === row.firstChild, selection?.anchorOffset],
				focus: [selection?.focusNode === row.firstChild, selection?.focusOffset],
				scrolls,
			},
		).toStrictEqual(
			{
				editingId: ROW_20,
				anchor: [true, 4],
				focus: [true, 1],
				scrolls: [500, 500],
			},
		);
	});

	it("focuses the first child at offset 0 and scrolls to the top for a location never saved", () =>
	{
		oweViewRestore(
			{
				id: "aaaaaaaaaaaa",
				query: null,
			},
		);
		restoreViewAfterSwap(ALICE, [ALICE, C1, C2]);
		expect(
			{
				editingId: useOutlineStore.getState().editingId,
				offset: useOutlineStore.getState().editingCaretOffset,
				scrolls,
			},
		).toStrictEqual(
			{
				editingId: C1,
				offset: 0,
				scrolls: [0],
			},
		);
	});

	it("focuses nothing for a search location never saved", () =>
	{
		oweViewRestore(
			{
				id: "aaaaaaaaaaaa",
				query: "x",
			},
		);
		restoreViewAfterSwap(ALICE, [ALICE, C1, C2]);
		expect(useOutlineStore.getState().editingId).toBeNull();
	});

	it("restores nothing for a zoom, which drops the restore it was owed", () =>
	{
		oweViewRestore(
			{
				id: "aaaaaaaaaaaa",
				query: null,
			},
		);
		goToNode(() => {}, ALICE);
		restoreViewAfterSwap(ALICE, [ALICE, C1, C2]);
		expect(
			{
				editingId: useOutlineStore.getState().editingId,
				scrolls,
			},
		).toStrictEqual(
			{
				editingId: null,
				scrolls: [],
			},
		);
	});
});
