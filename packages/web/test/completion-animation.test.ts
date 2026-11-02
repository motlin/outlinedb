import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("innerWidth", 1272);
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

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {scheduleCompletionHide, zoomOutDelayMs} = await import("../src/client/completion-animation.js");

function animationState()
{
	const {animatingCompletionIds, slidingUpCompletionIds} = useOutlineStore.getState();
	return {
		animating: [...animatingCompletionIds],
		sliding: [...slidingUpCompletionIds],
	};
}

describe("completion animation store", () =>
{
	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				animatingCompletionIds: new Set(),
				slidingUpCompletionIds: new Set(),
			},
		);
	});

	it("tracks animating ids, then sliding ids, and clears both on end", () =>
	{
		const store = useOutlineStore.getState();
		store.beginCompletionAnimation(["a", "b"]);
		const begun = animationState();
		store.startCompletionSlideUp(["a"]);
		const sliding = animationState();
		store.endCompletionAnimation(["a"]);
		expect(
			{
				begun,
				sliding,
				ended: animationState(),
			},
		).toStrictEqual(
			{
				begun:
				{
					animating: ["a", "b"],
					sliding: [],
				},
				sliding:
				{
					animating: ["a", "b"],
					sliding: ["a"],
				},
				ended:
				{
					animating: ["b"],
					sliding: [],
				},
			},
		);
	});
});

describe("scheduleCompletionHide", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
		useOutlineStore.setState(
			{
				animatingCompletionIds: new Set(),
				slidingUpCompletionIds: new Set(),
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("keeps the row for 1000ms, slides it up, and hides it after the 220ms fallback", () =>
	{
		scheduleCompletionHide(["a"], useOutlineStore.getState(), () => true);
		const start = animationState();
		vi.advanceTimersByTime(999);
		const waiting = animationState();
		vi.advanceTimersByTime(1);
		const sliding = animationState();
		vi.advanceTimersByTime(220);
		expect(
			{
				start,
				waiting,
				sliding,
				done: animationState(),
			},
		).toStrictEqual(
			{
				start:
				{
					animating: ["a"],
					sliding: [],
				},
				waiting:
				{
					animating: ["a"],
					sliding: [],
				},
				sliding:
				{
					animating: ["a"],
					sliding: ["a"],
				},
				done:
				{
					animating: [],
					sliding: [],
				},
			},
		);
	});

	it("skips the slide when the row is no longer hidden after the wait (uncompleted or shown)", () =>
	{
		scheduleCompletionHide(["a"], useOutlineStore.getState(), () => false);
		vi.advanceTimersByTime(1000);
		expect(animationState()).toStrictEqual(
			{
				animating: [],
				sliding: [],
			},
		);
	});

	it("slides up only the first 10 rows and hides the rest without animating", () =>
	{
		const ids = Array.from(
			{
				length: 12,
			},
			(_, index) => `n${index}`,
		);
		scheduleCompletionHide(ids, useOutlineStore.getState(), () => true);
		vi.advanceTimersByTime(1000);
		expect(animationState()).toStrictEqual(
			{
				animating: ids.slice(0, 10),
				sliding: ids.slice(0, 10),
			},
		);
	});
});

describe("zoomOutDelayMs", () =>
{
	it("is upstream's 500ms when shown, and the hide wait plus slide plus 500ms when hidden", () =>
	{
		expect([zoomOutDelayMs(true), zoomOutDelayMs(false)]).toStrictEqual([500, 1720]);
	});
});
