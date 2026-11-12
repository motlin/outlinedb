import {afterEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {beforeUnloadResult, createSyncStateDebouncer} = await import("../src/client/hooks/use-saving.js");

describe("createSyncStateDebouncer (upstream Wr1, 500ms)", () =>
{
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("never shows Saving... for a save that settles within 500ms", () =>
	{
		vi.useFakeTimers();
		const applied: boolean[] = [];
		const set = createSyncStateDebouncer((saving) =>
		{
			applied.push(saving);
		});
		set(true);
		vi.advanceTimersByTime(300);
		set(false);
		vi.advanceTimersByTime(500);
		expect(applied).toStrictEqual([]);
	});

	it("applies a save state that lasts 500ms, then its end", () =>
	{
		vi.useFakeTimers();
		const applied: boolean[] = [];
		const set = createSyncStateDebouncer((saving) =>
		{
			applied.push(saving);
		});
		set(true);
		vi.advanceTimersByTime(500);
		set(false);
		vi.advanceTimersByTime(500);
		expect(applied).toStrictEqual([true, false]);
	});
});

describe("beforeUnloadResult (upstream Cl0)", () =>
{
	it("asks to stay only while writes are in flight or an edit is pending", () =>
	{
		expect([
			beforeUnloadResult(
				{
					inFlight: 0,
					editPending: false,
				},
			),
			beforeUnloadResult(
				{
					inFlight: 2,
					editPending: false,
				},
			),
			beforeUnloadResult(
				{
					inFlight: 0,
					editPending: true,
				},
			),
		]).toStrictEqual([undefined, true, true]);
	});
});
