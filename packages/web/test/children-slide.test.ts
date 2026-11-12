import {describe, expect, it} from "vite-plus/test";
import {expansionSlide, pendingSlideAction} from "../src/client/children-slide.js";

describe("expansionSlide", () =>
{
	it("slides when the row itself expands or collapses, in or out of a search", () =>
	{
		expect([
			expansionSlide(
				{
					expanded: false,
					searching: false,
				},
				{
					expanded: true,
					searching: false,
				},
			),
			expansionSlide(
				{
					expanded: true,
					searching: false,
				},
				{
					expanded: false,
					searching: false,
				},
			),
			expansionSlide(
				{
					expanded: false,
					searching: true,
				},
				{
					expanded: true,
					searching: true,
				},
			),
			expansionSlide(
				{
					expanded: true,
					searching: true,
				},
				{
					expanded: false,
					searching: true,
				},
			),
		]).toStrictEqual(["down", "up", "down", "up"]);
	});

	it("does not slide when entering or leaving a search changes the expansion", () =>
	{
		expect([
			expansionSlide(
				{
					expanded: false,
					searching: false,
				},
				{
					expanded: true,
					searching: true,
				},
			),
			expansionSlide(
				{
					expanded: true,
					searching: true,
				},
				{
					expanded: false,
					searching: false,
				},
			),
			expansionSlide(
				{
					expanded: true,
					searching: true,
				},
				{
					expanded: true,
					searching: false,
				},
			),
		]).toStrictEqual([null, null, null]);
	});
});

describe("pendingSlideAction", () =>
{
	it("waits for children that are still loading on a slide down, runs once they mount, and drops after a second", () =>
	{
		expect([
			pendingSlideAction("down", false, 0),
			pendingSlideAction("down", true, 200),
			pendingSlideAction("down", false, 1000),
		]).toStrictEqual(["wait", "run", "drop"]);
	});

	it("drops a slide up without its element and a slide that is not pending", () =>
	{
		expect([pendingSlideAction("up", false, 0), pendingSlideAction(null, true, 0)]).toStrictEqual(["drop", "drop"]);
	});
});
