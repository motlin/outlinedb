import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import type {Animatable} from "../src/client/zoom-animation.js";
import
{
	ZOOM_MS,
	crossfadeClones,
	play,
	zoomAnimationAllowed,
	zoomOffset,
	zoomPhases,
} from "../src/client/zoom-animation.js";

/** An element whose `animate` records its keyframes and options, and whose animation finishes with `finished`. */
function fakeAnimatable(calls: unknown[], finished: Promise<unknown>): Animatable
{
	return {
		animate: (keyframes, options) =>
		{
			calls.push(["animate", keyframes, options]);
			return {
				finished,
				cancel: () =>
				{
					calls.push(["cancel"]);
				},
			};
		},
	};
}

const tw = readFileSync(fileURLToPath(new URL("../src/client/wf-tailwind.css", import.meta.url)), "utf8");

describe("zoom animation", () =>
{
	it("animates for 200ms", () =>
	{
		expect(ZOOM_MS).toBe(200);
	});

	it("offsets the moving row toward the other row, less the bullet indent and plus the title drop", () =>
	{
		expect(
			zoomOffset(
				{
					left: 76,
					top: 150,
				},
				{
					left: 40,
					top: 60,
				},
			),
		).toStrictEqual(
			{
				dx: -72,
				dy: -70,
			},
		);
	});

	it("skips on mobile, a board on either side, and reduced motion", () =>
	{
		const base =
		{
			mobile: false,
			board: false,
			reducedMotion: false,
		};
		expect([
			zoomAnimationAllowed(base),
			zoomAnimationAllowed(
				{
					...base,
					mobile: true,
				},
			),
			zoomAnimationAllowed(
				{
					...base,
					board: true,
				},
			),
			zoomAnimationAllowed(
				{
					...base,
					reducedMotion: true,
				},
			),
		]).toStrictEqual([true, false, false, false]);
	});

	it("zooming in moves the title, the row and its siblings out by the offset fading, and the children with them shown", () =>
	{
		expect(
			zoomPhases(
				false,
				{
					dx: -72,
					dy: -70,
				},
			),
		).toStrictEqual(
			{
				row:
				{
					from:
					{
						opacity: "1",
						transform: "",
					},
					to:
					{
						opacity: "0",
						transform: "translate(-72px, -70px)",
					},
				},
				children:
				{
					from:
					{
						opacity: "1",
						transform: "",
					},
					to:
					{
						opacity: "1",
						transform: "translate(-72px, -70px)",
					},
				},
				siblings:
				{
					from:
					{
						opacity: "1",
						transform: "",
					},
					to:
					{
						opacity: "0",
						transform: "translate(-72px, -70px)",
					},
				},
				title:
				{
					from:
					{
						opacity: "1",
						transform: "",
					},
					to:
					{
						opacity: "0",
						transform: "translate(-72px, -70px)",
					},
				},
			},
		);
	});

	it("zooming out brings the title, the row and its siblings back from the offset, and the children with them shown", () =>
	{
		expect(
			zoomPhases(
				true,
				{
					dx: 10,
					dy: 20,
				},
			),
		).toStrictEqual(
			{
				row:
				{
					from:
					{
						opacity: "0",
						transform: "translate(10px, 20px)",
					},
					to:
					{
						opacity: "1",
						transform: "",
					},
				},
				children:
				{
					from:
					{
						opacity: "1",
						transform: "translate(10px, 20px)",
					},
					to:
					{
						opacity: "1",
						transform: "",
					},
				},
				siblings:
				{
					from:
					{
						opacity: "0",
						transform: "translate(10px, 20px)",
					},
					to:
					{
						opacity: "1",
						transform: "",
					},
				},
				title:
				{
					from:
					{
						opacity: "0",
						transform: "translate(10px, 20px)",
					},
					to:
					{
						opacity: "1",
						transform: "",
					},
				},
			},
		);
	});

	it("zooming in crossfades the row-styled text under the title-styled text, both sliding from the row to the title", () =>
	{
		expect(
			crossfadeClones(
				false,
				{
					x: -24,
					y: -160,
				},
				16,
				32,
			),
		).toStrictEqual([
			{
				style: "row",
				from:
				{
					opacity: "1",
					transform: "",
				},
				to:
				{
					opacity: "0",
					transform: "translate(-24px, -160px) scale(2)",
				},
			},
			{
				style: "title",
				from:
				{
					opacity: "1",
					transform: "scale(0.5)",
				},
				to:
				{
					opacity: "1",
					transform: "translate(-24px, -160px)",
				},
			},
		]);
	});

	it("zooming out crossfades the title-styled text under the row-styled text, both sliding from the title to the row", () =>
	{
		expect(
			crossfadeClones(
				true,
				{
					x: -24,
					y: -160,
				},
				16,
				32,
			),
		).toStrictEqual([
			{
				style: "title",
				from:
				{
					opacity: "1",
					transform: "translate(-24px, -160px)",
				},
				to:
				{
					opacity: "0",
					transform: "scale(0.5)",
				},
			},
			{
				style: "row",
				from:
				{
					opacity: "1",
					transform: "translate(-24px, -160px) scale(2)",
				},
				to:
				{
					opacity: "1",
					transform: "",
				},
			},
		]);
	});

	it("plays each step as a Web Animation holding its end look, so no row fires transitionend", async () =>
	{
		const calls: unknown[] = [];
		const el = fakeAnimatable(calls, Promise.resolve());
		await play([
			{
				el,
				from:
				{
					opacity: "1",
					transform: "",
				},
				to:
				{
					opacity: "0",
					transform: "translate(-72px, -70px)",
				},
			},
		]);
		expect(calls).toStrictEqual([
			[
				"animate",
				[
					{
						opacity: "1",
						transform: "none",
					},
					{
						opacity: "0",
						transform: "translate(-72px, -70px)",
					},
				],
				{
					duration: 200,
					easing: "ease",
					fill: "forwards",
				},
			],
			["cancel"],
		]);
	});

	it("settles in a task of its own after the animations finish, not in the frame that finished them", async () =>
	{
		const calls: unknown[] = [];
		const order: string[] = [];
		const settled = (async () =>
		{
			await play([
				{
					el: fakeAnimatable(calls, Promise.resolve()),
					from:
					{
						opacity: "1",
						transform: "",
					},
					to:
					{
						opacity: "0",
						transform: "",
					},
				},
			]);
			order.push("settled");
		})();
		// Drain the finishing frame's microtasks: a settle that waits for no new task lands among them.
		for (let tick = 0; tick < 20; tick++)
		{
			// oxlint-disable-next-line no-await-in-loop -- each tick is one microtask
			await Promise.resolve();
		}
		order.push("frame over");
		await settled;
		expect(order).toStrictEqual(["frame over", "settled"]);
	});

	it("keeps upstream's zooming utility rules verbatim", () =>
	{
		expect([
			tw.includes(
				".item--zooming-in-progress .\\[\\.item--zooming-in-progress_\\&\\]\\:hidden {\n  display: none\n}",
			),
			tw.includes(
				".item--zooming-in-progress .\\[\\.item--zooming-in-progress_\\&\\]\\:border-l-transparent {\n  border-left-color: transparent\n}",
			),
		]).toStrictEqual([true, true]);
	});
});
