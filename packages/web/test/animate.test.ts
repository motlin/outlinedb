import {describe, expect, it} from "vite-plus/test";
import {slideDown, slideUp} from "../src/client/animate.js";

type Listener = (event: {target: unknown}) => void;

interface FakeElement
{
	style: Record<string, string>;
	addEventListener: (type: string, listener: Listener) => void;
	removeEventListener: (type: string, listener: Listener) => void;
	dispatch: (type: string, target?: unknown) => void;
	listenerCount: (type: string) => number;
}

function fakeElement(): FakeElement
{
	const listeners = new Map<string, Set<Listener>>();
	const el: FakeElement =
	{
		style: {},
		addEventListener(type: string, listener: Listener)
		{
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, listener: Listener)
		{
			listeners.get(type)?.delete(listener);
		},
		dispatch(type: string, target: unknown = el)
		{
			for (const listener of listeners.get(type) ?? [])
			{
				listener(
					{
						target,
					},
				);
			}
		},
		listenerCount(type: string)
		{
			return listeners.get(type)?.size ?? 0;
		},
	};
	return el;
}

function fakeDeps(reducedMotion = false)
{
	const frames: (() => void)[] = [];
	const timers:
	{
		cb: () => void;
		ms: number;
	}[] = [];
	return {
		frames,
		timers,
		deps:
		{
			raf: (cb: () => void) =>
			{
				frames.push(cb);
			},
			setTimeout: (cb: () => void, ms: number) =>
			{
				timers.push(
					{
						cb,
						ms,
					},
				);
			},
			reducedMotion,
		},
		flushFrames()
		{
			for (const cb of frames.splice(0))
			{
				cb();
			}
		},
	};
}

describe("slideDown", () =>
{
	it("starts collapsed, transitions open on the next frame, and clears styles on transitionend", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps();
		let done = 0;
		slideDown(el, fake.deps, () =>
		{
			done += 1;
		});
		expect(el.style).toStrictEqual(
			{
				opacity: "0",
				transform: "scale(0.2, 0)",
				transformOrigin: "0 0",
				willChange: "transform, opacity",
			},
		);

		fake.flushFrames();
		expect(el.style).toStrictEqual(
			{
				opacity: "1",
				transform: "scale(1, 1)",
				transformOrigin: "0 0",
				willChange: "transform, opacity",
				transition: "opacity 120ms, transform 120ms",
			},
		);

		el.dispatch("transitionend", {});
		expect(
			{
				style: el.style,
				done,
			},
		).toStrictEqual(
			{
				style:
				{
					opacity: "1",
					transform: "scale(1, 1)",
					transformOrigin: "0 0",
					willChange: "transform, opacity",
					transition: "opacity 120ms, transform 120ms",
				},
				done: 0,
			},
		);

		el.dispatch("transitionend");
		expect(
			{
				style: el.style,
				done,
				listeners: el.listenerCount("transitionend"),
			},
		).toStrictEqual(
			{
				style:
				{
					transformOrigin: "0px 0px",
				},
				done: 1,
				listeners: 0,
			},
		);
	});

	it("finishes on the fallback timer when transitionend never fires, only once", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps();
		let done = 0;
		slideDown(el, fake.deps, () =>
		{
			done += 1;
		});
		fake.flushFrames();
		expect(fake.timers.map(({ms}) => ms)).toStrictEqual([220]);
		fake.timers[0]?.cb();
		el.dispatch("transitionend");
		expect(
			{
				style: el.style,
				done,
			},
		).toStrictEqual(
			{
				style:
				{
					transformOrigin: "0px 0px",
				},
				done: 1,
			},
		);
	});

	it("does nothing but finish under prefers-reduced-motion", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps(true);
		let done = 0;
		slideDown(el, fake.deps, () =>
		{
			done += 1;
		});
		expect(
			{
				style: el.style,
				done,
				frames: fake.frames.length,
			},
		).toStrictEqual(
			{
				style: {},
				done: 1,
				frames: 0,
			},
		);
	});

	it("cancel clears the inline styles without finishing", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps();
		let done = 0;
		const cancel = slideDown(el, fake.deps, () =>
		{
			done += 1;
		});
		cancel();
		fake.flushFrames();
		el.dispatch("transitionend");
		expect(
			{
				style: el.style,
				done,
				listeners: el.listenerCount("transitionend"),
			},
		).toStrictEqual(
			{
				style: {},
				done: 0,
				listeners: 0,
			},
		);
	});
});

describe("slideUp", () =>
{
	it("transitions to collapsed on the next frame and finishes on transitionend", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps();
		let done = 0;
		slideUp(el, fake.deps, () =>
		{
			done += 1;
		});
		expect(el.style).toStrictEqual(
			{
				opacity: "1",
				transform: "scale(1, 1)",
				transformOrigin: "0 0",
				willChange: "transform, opacity",
			},
		);

		fake.flushFrames();
		expect(el.style).toStrictEqual(
			{
				opacity: "0",
				transform: "scale(0.2, 0)",
				transformOrigin: "0 0",
				willChange: "transform, opacity",
				transition: "opacity 120ms, transform 120ms",
			},
		);

		el.dispatch("transitionend");
		expect(
			{
				style: el.style,
				done,
			},
		).toStrictEqual(
			{
				style: {},
				done: 1,
			},
		);
	});

	it("finishes at once under prefers-reduced-motion", () =>
	{
		const el = fakeElement();
		const fake = fakeDeps(true);
		let done = 0;
		slideUp(el, fake.deps, () =>
		{
			done += 1;
		});
		expect(
			{
				style: el.style,
				done,
			},
		).toStrictEqual(
			{
				style: {},
				done: 1,
			},
		);
	});
});
