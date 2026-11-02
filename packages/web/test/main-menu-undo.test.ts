import {describe, expect, it, vi} from "vite-plus/test";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (state: {openExportDialog: () => void; lastSavedAt: number}) => unknown) =>
		selector(
			{
				openExportDialog: () =>
				{
				},
				lastSavedAt: 0,
			},
		),
}));
vi.mock("../src/client/hooks/use-saving.js", () => (
{
	useSaving: () => false,
}));

/** renderToStaticMarkup reads zustand's initial state, so the seeded stack state comes through a mock. */
const undoState =
{
	canUndo: false,
	canRedo: false,
};
vi.mock("../src/client/undo-history.js", () => (
{
	useUndoStore: (selector: (state: typeof undoState) => unknown) => selector(undoState),
}));

const {useMainMenuRows} = await import("../src/client/components/main-menu-rows.js");
const {renderMainMenuRows} = await import("./helpers/render-main-menu-rows.js");

function seed(state: typeof undoState): void
{
	Object.assign(undoState, state);
}

function render(): string
{
	return renderMainMenuRows(useMainMenuRows);
}

/** The row's `<a>` open tag attributes' disabled look: upstream greys a disabled MenuItem with text-tertiary. */
function row(html: string, label: string): string | undefined
{
	return html.split("<a ").find((anchor) => anchor.includes(`desktop:text-xs">`) && anchor.includes(`${label}<`));
}

function disabled(anchor: string | undefined): boolean | undefined
{
	return anchor === undefined ? undefined : anchor.includes("\n        text-tertiary\n");
}

describe("GearMenu undo/redo rows", () =>
{
	it("enables Undo and disables Redo from the undo store", () =>
	{
		seed(
			{
				canUndo: true,
				canRedo: false,
			},
		);
		const html = render();
		expect(
			{
				undo: disabled(row(html, "Undo")),
				redo: disabled(row(html, "Redo")),
			},
		).toStrictEqual(
			{
				undo: false,
				redo: true,
			},
		);
	});

	it("enables Redo and disables Undo from the undo store", () =>
	{
		seed(
			{
				canUndo: false,
				canRedo: true,
			},
		);
		const html = render();
		expect(
			{
				undo: disabled(row(html, "Undo")),
				redo: disabled(row(html, "Redo")),
			},
		).toStrictEqual(
			{
				undo: true,
				redo: false,
			},
		);
	});

	it("has no Save row", () =>
	{
		const html = render();
		// "Autosaved" belongs to the status footer only, never a Save row's subtitle.
		expect(
			{
				save: row(html, "Save"),
				autosavedSubtitle: html.includes("Autosaved</span>"),
			},
		).toStrictEqual(
			{
				save: undefined,
				autosavedSubtitle: false,
			},
		);
	});
});
