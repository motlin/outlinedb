import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createEditDebouncer} from "../src/client/edit-debouncer.js";
import type {TextEdit} from "../src/client/edit-debouncer.js";

function setup(saved = "UR Alpha one")
{
	const saves: TextEdit[] = [];
	const debouncer = createEditDebouncer(
		{
			delay: 500,
			save: (edit) =>
			{
				saves.push(edit);
			},
		},
	);
	debouncer.reset(saved);
	return {
		debouncer,
		saves,
	};
}

describe("createEditDebouncer", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("saves once after 500ms idle, with the last value typed", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one t");
		vi.advanceTimersByTime(300);
		debouncer.change("UR Alpha one tw");
		vi.advanceTimersByTime(499);
		expect(saves).toStrictEqual([]);
		vi.advanceTimersByTime(1);
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one tw",
			},
		]);
		vi.advanceTimersByTime(5000);
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one tw",
			},
		]);
	});

	it("saves one batch per pause: type, pause, type", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one two");
		vi.advanceTimersByTime(500);
		debouncer.change("UR Alpha one two three");
		vi.advanceTimersByTime(500);
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one two",
			},
			{
				before: "UR Alpha one two",
				after: "UR Alpha one two three",
			},
		]);
	});

	it("flush saves the pending text immediately and cancels the timer", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one two");
		expect(debouncer.pending).toBe(true);
		debouncer.flush();
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one two",
			},
		]);
		expect(debouncer.pending).toBe(false);
		expect(debouncer.saved).toBe("UR Alpha one two");
		vi.advanceTimersByTime(500);
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one two",
			},
		]);
	});

	it("flush with nothing pending saves nothing", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.flush();
		expect(saves).toStrictEqual([]);
	});

	it("skips a save when the text returned to the saved value", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one!");
		debouncer.change("UR Alpha one");
		vi.advanceTimersByTime(500);
		debouncer.flush();
		expect(saves).toStrictEqual([]);
	});

	it("reset adopts a new saved value and drops the pending save", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one two");
		debouncer.reset("UR Beta");
		expect(debouncer.pending).toBe(false);
		vi.advanceTimersByTime(500);
		debouncer.change("UR Beta two");
		debouncer.flush();
		expect(saves).toStrictEqual([
			{
				before: "UR Beta",
				after: "UR Beta two",
			},
		]);
	});

	it("saveNow saves the given value at once, debounced or not", () =>
	{
		const {debouncer, saves} = setup();
		debouncer.change("UR Alpha one t");
		debouncer.saveNow("UR Alpha one two");
		vi.advanceTimersByTime(500);
		debouncer.saveNow("UR Alpha one two");
		expect(saves).toStrictEqual([
			{
				before: "UR Alpha one",
				after: "UR Alpha one two",
			},
		]);
	});
});
