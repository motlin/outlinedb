import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {hasMirrorsClass, isMirrorRoot, projectClassName} from "../src/client/components/row-classes.js";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => ({}),
	},
	outlineActions: {},
}));
const {nodeBullet} = await import("../src/client/components/node-bullet.js");

const original =
{
	isMirror: false,
	hasMirrors: true,
};
const mirror =
{
	isMirror: true,
	hasMirrors: false,
};
const plain =
{
	isMirror: false,
	hasMirrors: false,
};

function projectClass(node: {isMirror: boolean; hasMirrors: boolean}): string
{
	return projectClassName(
		{
			hasChildren: false,
			expanded: true,
			completed: false,
			hasNote: false,
			noteFocused: false,
			isZoomRoot: false,
			hasMirrors: hasMirrorsClass(node),
			highlighted: false,
			addedToSelection: false,
		},
	);
}

function bulletMarkup(node: {isMirror: boolean; hasMirrors: boolean}): string
{
	return renderToStaticMarkup(
		createElement(
			"div",
			null,
			nodeBullet(
				{
					nodeId: "n1",
					isMirror: isMirrorRoot(node),
					showHalo: false,
					keepBullet: false,
					onMouseDown: () =>
					{
					},
					onZoom: () =>
					{
					},
					isInSelection: () => false,
					onClearSelection: () =>
					{
					},
				},
			),
		),
	);
}

describe("mirror roots", () =>
{
	it("gives an original with mirrors the hasMirrors project class, and a mirror or plain row none", () =>
	{
		expect([projectClass(original), projectClass(mirror), projectClass(plain)]).toStrictEqual([
			"font-custom project hasMirrors task",
			"font-custom project task",
			"font-custom project task",
		]);
	});

	it("draws the diamond on the original and the mirror, and the circle on a plain row", () =>
	{
		const diamond =
			'<span class="bulletHalo"><svg width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor" class="mirrorDiamondIcon"><path d="M8 4 L4 8 L8 12 L12 8 Z"></path></svg></span>';
		expect([bulletMarkup(original).includes(diamond), bulletMarkup(mirror).includes(diamond)]).toStrictEqual([
			true,
			true,
		]);
		expect(bulletMarkup(original)).toContain('class="bullet diamond"');
		expect(bulletMarkup(plain)).toContain('class="bullet"');
		expect(bulletMarkup(plain)).toContain("zoomBulletIcon");
	});
});
