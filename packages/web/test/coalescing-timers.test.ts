import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createCoalescingTimeoutProvider} from "../src/client/coalescing-timers.js";

beforeEach(() =>
{
	vi.useFakeTimers(
		{
			now: 0,
		},
	);
});

afterEach(() =>
{
	vi.useRealTimers();
});

describe("createCoalescingTimeoutProvider", () =>
{
	it("shares one platform timer among long timeouts due in the same second, firing each no earlier than asked", () =>
	{
		const provider = createCoalescingTimeoutProvider();
		const fired: number[] = [];
		const platformTimers = vi.getTimerCount();
		for (let index = 0; index < 500; index += 1)
		{
			provider.setTimeout(() =>
			{
				fired.push(index);
			}, 60_001 + index);
		}
		const scheduled = vi.getTimerCount() - platformTimers;
		vi.advanceTimersByTime(60_000);
		const early = fired.length;
		vi.advanceTimersByTime(1500);
		expect(
			{
				scheduled,
				early,
				fired: fired.length,
			},
		).toStrictEqual(
			{
				scheduled: 1,
				early: 0,
				fired: 500,
			},
		);
	});

	it("cancels a coalesced timeout, and drops the platform timer once its whole batch is cancelled", () =>
	{
		const provider = createCoalescingTimeoutProvider();
		const fired: string[] = [];
		const kept = provider.setTimeout(() =>
		{
			fired.push("kept");
		}, 60_000);
		const cancelled = provider.setTimeout(() =>
		{
			fired.push("cancelled");
		}, 60_000);
		provider.clearTimeout(cancelled);
		const lone = provider.setTimeout(() =>
		{
			fired.push("lone");
		}, 300_000);
		provider.clearTimeout(lone);
		const afterCancel = vi.getTimerCount();
		vi.advanceTimersByTime(400_000);
		provider.clearTimeout(kept);
		expect(
			{
				afterCancel,
				fired,
			},
		).toStrictEqual(
			{
				afterCancel: 1,
				fired: ["kept"],
			},
		);
	});

	it("leaves short timeouts and intervals to the platform, unbatched", () =>
	{
		const provider = createCoalescingTimeoutProvider();
		const fired: string[] = [];
		provider.setTimeout(() =>
		{
			fired.push("short");
		}, 10);
		const interval = provider.setInterval(() =>
		{
			fired.push("tick");
		}, 20);
		vi.advanceTimersByTime(10);
		const atTen = [...fired];
		vi.advanceTimersByTime(30);
		provider.clearInterval(interval);
		vi.advanceTimersByTime(100);
		expect(
			{
				atTen,
				fired,
			},
		).toStrictEqual(
			{
				atTen: ["short"],
				fired: ["short", "tick", "tick"],
			},
		);
	});
});
