import {describe, expect, it} from "vite-plus/test";
import {outlineRootToShow, showZoom} from "../src/client/show-zoom.js";

function run(paneId: string | null, scrollTop: boolean): string[]
{
	const calls: string[] = [];
	showZoom(
		"alice",
		scrollTop,
		{
			paneId,
			zoomPane: (pane, id) =>
			{
				calls.push(`pane:${pane}:${id}`);
			},
			goToNode: (id) =>
			{
				calls.push(`url:${id}`);
			},
			scrollToTop: (pane) =>
			{
				calls.push(`scroll:${pane ?? "main"}`);
			},
		},
	);
	return calls;
}

describe("showZoom", () =>
{
	it("navigates the main outline and scrolls the page while the main pane is active", () =>
	{
		expect(run(null, true)).toStrictEqual(["url:alice", "scroll:main"]);
	});

	it("zooms the active pane and scrolls its scroller, leaving the URL alone", () =>
	{
		expect(run("BBBBBBBBBBB", true)).toStrictEqual(["pane:BBBBBBBBBBB:alice", "scroll:BBBBBBBBBBB"]);
	});

	it("keeps the scroll position when the zoom does not scroll to the top", () =>
	{
		expect(run("BBBBBBBBBBB", false)).toStrictEqual(["pane:BBBBBBBBBBB:alice"]);
	});
});

describe("outlineRootToShow", () =>
{
	it("shows the requested root once its children are loaded", () =>
	{
		expect(outlineRootToShow("bob", false, "alice")).toBe("bob");
	});

	it("keeps the previous root on screen while the requested root's children load", () =>
	{
		expect(outlineRootToShow("bob", true, "alice")).toBe("alice");
	});

	it("keeps Home on screen while a zoom away from it loads", () =>
	{
		expect(outlineRootToShow("bob", true, null)).toBeNull();
	});

	it("shows the requested root (and its loading state) when nothing was shown yet", () =>
	{
		expect(outlineRootToShow("bob", true, undefined)).toBe("bob");
	});
});
