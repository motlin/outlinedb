// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {pickHoverProbeOffsets, resolveHoveredRow} from "../src/client/gutter-hover.js";

function fixture()
{
	document.body.innerHTML = `
		<div class="pageContainer">
			<div class="project" projectid="a"><div class="name" id="nameA"><span id="textA"></span></div><div class="children" id="childrenA"></div></div>
			<div class="project" projectid="b"><div class="name" id="nameB"></div></div>
			<div id="gutter"></div>
		</div>
		<div id="outside"></div>`;
	const el = (id: string) => document.getElementById(id);
	return {
		el,
	};
}

describe("pickHoverProbeOffsets", () =>
{
	it("probes 200px either side, or 100px with panes open", () =>
	{
		expect(
			{
				closed: pickHoverProbeOffsets(false),
				open: pickHoverProbeOffsets(true),
			},
		).toStrictEqual(
			{
				closed: [-200, 200],
				open: [-100, 100],
			},
		);
	});
});

describe("resolveHoveredRow", () =>
{
	it("hovers the row whose name holds the target", () =>
	{
		const {el} = fixture();
		expect(resolveHoveredRow(el("textA"), () => null)).toBe("a");
	});

	it("probes sideways from the gutter or a children strip, the first offset winning", () =>
	{
		const {el} = fixture();
		const hits = [el("nameB"), el("nameA")];
		const pointAt = (dx: number) => (dx < 0 ? hits[0] : hits[1]);
		expect(
			{
				gutter: resolveHoveredRow(el("gutter"), pointAt),
				children: resolveHoveredRow(el("childrenA"), (dx) => (dx > 0 ? el("nameA") : null)),
				ignoresChildrenHit: resolveHoveredRow(el("gutter"), () => el("childrenA")),
				nothing: resolveHoveredRow(el("gutter"), () => null),
			},
		).toStrictEqual(
			{
				gutter: "b",
				children: "a",
				ignoresChildrenHit: null,
				nothing: null,
			},
		);
	});

	it("clears outside the page container", () =>
	{
		const {el} = fixture();
		expect(resolveHoveredRow(el("outside"), () => el("nameA"))).toBeNull();
	});
});
