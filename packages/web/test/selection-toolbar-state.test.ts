import {describe, expect, it} from "vite-plus/test";
import
{
	initialToolbarState,
	toolbarFormatAttr,
	toolbarLayoutCommand,
	toolbarState,
	toolbarRefreshKey,
} from "../src/client/hooks/use-selection-toolbar.js";
import type {ToolbarEvent, ToolbarState} from "../src/client/hooks/use-selection-toolbar.js";

function run(events: readonly ToolbarEvent[], start: ToolbarState = initialToolbarState(false)): ToolbarState
{
	return events.reduce(toolbarState, start);
}

const stretched =
{
	type: "selectionchange",
	stretched: true,
	popupOpen: false,
} as const;
const collapsed =
{
	type: "selectionchange",
	stretched: false,
	popupOpen: false,
} as const;
const pointerupStretched =
{
	type: "pointerup",
	stretched: true,
	popupOpen: false,
} as const;
const pointerdownOutside =
{
	type: "pointerdown",
	insideCtxMenu: false,
} as const;

describe("toolbarState", () =>
{
	it("starts hidden, remembering whether the primary button is down", () =>
	{
		expect(initialToolbarState(false)).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: false,
			},
		);
		expect(initialToolbarState(true)).toStrictEqual(
			{
				visible: false,
				pointerDown: true,
				composing: false,
			},
		);
	});

	it("ignores selection changes while the primary button is down and opens on pointerup", () =>
	{
		const dragging = run([pointerdownOutside, stretched]);
		expect(dragging).toStrictEqual(
			{
				visible: false,
				pointerDown: true,
				composing: false,
			},
		);
		expect(run([pointerupStretched], dragging)).toStrictEqual(
			{
				visible: true,
				pointerDown: false,
				composing: false,
			},
		);
	});

	it("opens on a keyboard-stretched selection and closes when it collapses", () =>
	{
		const open = run([stretched]);
		expect(open).toStrictEqual(
			{
				visible: true,
				pointerDown: false,
				composing: false,
			},
		);
		expect(run([collapsed], open)).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: false,
			},
		);
	});

	it("stays closed through a composition and resumes at compositionend", () =>
	{
		const composing = run([
			{
				type: "compositionstart",
			},
			stretched,
		]);
		expect(composing).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: true,
			},
		);
		expect(
			run(
				[
					{
						type: "compositionend",
					},
					stretched,
				],
				composing,
			),
		).toStrictEqual(
			{
				visible: true,
				pointerDown: false,
				composing: false,
			},
		);
	});

	it("closes when composition starts while open", () =>
	{
		expect(
			run([
				stretched,
				{
					type: "compositionstart",
				},
			]),
		).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: true,
			},
		);
	});

	it("stays open on a pointerdown inside the ctx-menu and closes on one outside", () =>
	{
		expect(
			run([
				stretched,
				{
					type: "pointerdown",
					insideCtxMenu: true,
				},
			]),
		).toStrictEqual(
			{
				visible: true,
				pointerDown: true,
				composing: false,
			},
		);
		expect(run([stretched, pointerdownOutside])).toStrictEqual(
			{
				visible: false,
				pointerDown: true,
				composing: false,
			},
		);
	});

	it("does not open while another popup is open, but stays open when already open", () =>
	{
		expect(
			run([
				{
					type: "pointerup",
					stretched: true,
					popupOpen: true,
				},
			]),
		).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: false,
			},
		);
		expect(
			run([
				stretched,
				{
					type: "selectionchange",
					stretched: true,
					popupOpen: true,
				},
			]),
		).toStrictEqual(
			{
				visible: true,
				pointerDown: false,
				composing: false,
			},
		);
	});

	it("closes on Escape", () =>
	{
		expect(
			run([
				stretched,
				{
					type: "escape",
				},
			]),
		).toStrictEqual(
			{
				visible: false,
				pointerDown: false,
				composing: false,
			},
		);
	});
});

describe("toolbar actions", () =>
{
	it("maps format buttons to inline attributes and type buttons to layout toggles", () =>
	{
		const actions = [
			"h1",
			"h2",
			"h3",
			"p",
			"bold",
			"underline",
			"italic",
			"strikethrough",
			"code-format",
			"link",
			"latest-color",
			"show-palette",
		] as const;
		expect(
			actions.map((action) => [action, toolbarFormatAttr(action), toolbarLayoutCommand(action)]),
		).toStrictEqual([
			["h1", null, "toggle_h1"],
			["h2", null, "toggle_h2"],
			["h3", null, "toggle_h3"],
			["p", null, "toggle_paragraph"],
			["bold", "b", null],
			["underline", "u", null],
			["italic", "i", null],
			["strikethrough", "s", null],
			["code-format", "code", null],
			["link", null, null],
			["latest-color", null, null],
			["show-palette", null, null],
		]);
	});
});

describe("toolbarRefreshKey", () =>
{
	it("is stable per normalized layout and differs between layouts", () =>
	{
		expect([
			toolbarRefreshKey("h1") === toolbarRefreshKey("h1"),
			toolbarRefreshKey("h1") === toolbarRefreshKey(null),
			toolbarRefreshKey("paragraph") === toolbarRefreshKey("p"),
			toolbarRefreshKey(undefined) === toolbarRefreshKey(null),
		]).toStrictEqual([true, false, true, true]);
	});
});
