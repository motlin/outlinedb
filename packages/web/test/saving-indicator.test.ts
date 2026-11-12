import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vite-plus/test";

/** Upstream never blocks input while saving; its only save state is the main menu's autosave footer (KY). */

const outlineState =
{
	openExportDialog: () =>
	{
	},
	lastSavedAt: 0,
};
const saving =
{
	value: false,
};
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (state: typeof outlineState) => unknown) => selector(outlineState),
}));
vi.mock("../src/client/hooks/use-saving.js", () => (
{
	useSaving: () => saving.value,
}));

const {useMainMenuRows} = await import("../src/client/components/main-menu-rows.js");
const {renderMainMenuRows} = await import("./helpers/render-main-menu-rows.js");

function autosaveFooter(inFlight: number): string | undefined
{
	saving.value = inFlight > 0;
	Object.assign(
		outlineState,
		{
			lastSavedAt: Date.now(),
		},
	);
	const html = renderMainMenuRows(useMainMenuRows);
	// The footer is the menu's last row, so it runs up to the closing scroller div.
	const start = html.indexOf(
		'<div class="flex items-center justify-center text-center leading-none text-tertiary text-xs py-xs">',
	);
	return start === -1 ? undefined : html.slice(start, -"</div>".length);
}

describe("saving indicator", () =>
{
	it("has no full-screen overlay that could swallow clicks", () =>
	{
		const app = readFileSync(new URL("../src/client/app.tsx", import.meta.url), "utf8");
		const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
		expect(
			{
				appOverlay: app.includes("LoadingOverlay") || app.includes("Saving changes..."),
				overlayCss: styles.includes(".loading-overlay"),
			},
		).toStrictEqual(
			{
				appOverlay: false,
				overlayCss: false,
			},
		);
	});

	it("shows a spinner and Saving... in the main menu footer while writes are in flight", () =>
	{
		expect(autosaveFooter(2)).toBe(
			'<div class="flex items-center justify-center text-center leading-none text-tertiary text-xs py-xs"><div class="loading-spinner loading-spinner-small"><div class="loading-spinner-circle"></div></div>Saving...</div>',
		);
	});

	it("shows Autosaved: Just now once writes settle", () =>
	{
		expect(autosaveFooter(0)).toBe(
			'<div class="flex items-center justify-center text-center leading-none text-tertiary text-xs py-xs">Autosaved: Just now</div>',
		);
	});
});
