import {describe, expect, it} from "vite-plus/test";
import {MOVE_REVEAL_BUFFER, revealDelta} from "../src/client/reveal-row.js";

const view =
{
	top: 0,
	bottom: 300,
};

describe("revealDelta", () =>
{
	it("scrolls down by how far a row below the fold sits past the bottom buffer", () =>
	{
		expect(
			revealDelta(
				{
					top: 340,
					bottom: 364,
				},
				view,
				MOVE_REVEAL_BUFFER,
			),
		).toBe(184);
	});

	it("does not scroll for a row inside both buffers", () =>
	{
		expect(
			revealDelta(
				{
					top: 150,
					bottom: 174,
				},
				view,
				MOVE_REVEAL_BUFFER,
			),
		).toBe(0);
	});

	it("scrolls up by how far a row sits above the top buffer", () =>
	{
		expect(
			revealDelta(
				{
					top: 50,
					bottom: 74,
				},
				view,
				MOVE_REVEAL_BUFFER,
			),
		).toBe(-66);
	});

	it("only keeps the row in view without buffers", () =>
	{
		expect([
			revealDelta(
				{
					top: 280,
					bottom: 304,
				},
				view,
				{
					above: 0,
					below: 0,
				},
			),
			revealDelta(
				{
					top: 150,
					bottom: 174,
				},
				view,
				{
					above: 0,
					below: 0,
				},
			),
			revealDelta(
				{
					top: -10,
					bottom: 14,
				},
				view,
				{
					above: 0,
					below: 0,
				},
			),
		]).toStrictEqual([4, 0, -10]);
	});
});
