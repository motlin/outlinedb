import {describe, expect, it} from "vite-plus/test";
import
{
	BACK_STACK_CAP,
	emptyMainPaneHistory,
	initialNavState,
	locFromHash,
	navReducer,
	rememberMainPaneMove,
	stepMainPaneHistory,
} from "../src/client/nav-stack.js";
import type {Loc, MainPaneHistory, NavState} from "../src/client/nav-stack.js";

function loc(id: string | null, query: string | null = null): Loc
{
	return {
		id,
		query,
	};
}

function navigateAll(ids: string[], from: NavState = initialNavState): NavState
{
	return ids.reduce(
		(state, id) =>
			navReducer(
				state,
				{
					type: "navigate",
					loc: loc(id),
				},
			),
		from,
	);
}

describe("navReducer", () =>
{
	it("starts with no current location and empty stacks", () =>
	{
		expect(initialNavState).toStrictEqual(
			{
				current: null,
				back: [],
				forward: [],
			},
		);
	});

	it("navigate a, b, c then back moves c to forward", () =>
	{
		const state = navReducer(
			navigateAll(["a", "b", "c"]),
			{
				type: "back",
			},
		);
		expect(state).toStrictEqual(
			{
				current: loc("b"),
				back: [loc("a")],
				forward: [loc("c")],
			},
		);
	});

	it("forward mirrors back", () =>
	{
		const back = navReducer(
			navigateAll(["a", "b", "c"]),
			{
				type: "back",
			},
		);
		expect(
			navReducer(
				back,
				{
					type: "forward",
				},
			),
		).toStrictEqual(
			{
				current: loc("c"),
				back: [loc("a"), loc("b")],
				forward: [],
			},
		);
	});

	it("navigate after back clears forward", () =>
	{
		const back = navReducer(
			navigateAll(["a", "b", "c"]),
			{
				type: "back",
			},
		);
		expect(
			navReducer(
				back,
				{
					type: "navigate",
					loc: loc("d"),
				},
			),
		).toStrictEqual(
			{
				current: loc("d"),
				back: [loc("a"), loc("b")],
				forward: [],
			},
		);
	});

	it("navigate to the current location returns the same object", () =>
	{
		const state = navigateAll(["a", "b"]);
		expect(
			navReducer(
				state,
				{
					type: "navigate",
					loc: loc("b"),
				},
			),
		).toBe(state);
	});

	it("navigate to the same id with a new query is not deduped", () =>
	{
		const state = navReducer(
			navigateAll(["a"]),
			{
				type: "navigate",
				loc: loc("a", "x"),
			},
		);
		expect(state).toStrictEqual(
			{
				current: loc("a", "x"),
				back: [loc("a")],
				forward: [],
			},
		);
	});

	it("caps the back stack, dropping the oldest entries", () =>
	{
		const ids = Array.from(
			{
				length: BACK_STACK_CAP + 2,
			},
			(_, i) => `n${i}`,
		);
		const state = navigateAll(ids);
		expect(
			{
				cap: BACK_STACK_CAP,
				length: state.back.length,
				oldest: state.back[0],
			},
		).toStrictEqual(
			{
				cap: 100,
				length: 100,
				oldest: loc("n1"),
			},
		);
	});

	it("popstate sets current without touching the stacks", () =>
	{
		const before = navReducer(
			navigateAll(["a", "b", "c"]),
			{
				type: "back",
			},
		);
		expect(
			navReducer(
				before,
				{
					type: "popstate",
					loc: loc("x"),
				},
			),
		).toStrictEqual(
			{
				current: loc("x"),
				back: [loc("a")],
				forward: [loc("c")],
			},
		);
	});

	it("replace sets current without touching the stacks", () =>
	{
		const before = navReducer(
			navigateAll(["a", "b", "c"]),
			{
				type: "back",
			},
		);
		expect(
			navReducer(
				before,
				{
					type: "replace",
					loc: loc("x"),
				},
			),
		).toStrictEqual(
			{
				current: loc("x"),
				back: [loc("a")],
				forward: [loc("c")],
			},
		);
	});

	it("back and forward on empty stacks return the same object", () =>
	{
		const state = navigateAll(["a"]);
		expect(
			navReducer(
				state,
				{
					type: "back",
				},
			),
		).toBe(state);
		expect(
			navReducer(
				state,
				{
					type: "forward",
				},
			),
		).toBe(state);
	});
});

describe("locFromHash", () =>
{
	it("keys locations by short id and keeps the query", () =>
	{
		expect(
			{
				home: locFromHash(""),
				full: locFromHash("#/4823cefa-5fc0-478c-88ac-35035d443bf1"),
				query: locFromHash("#/35035d443bf1?q=x"),
			},
		).toStrictEqual(
			{
				home: loc(null),
				full: loc("35035d443bf1"),
				query: loc("35035d443bf1", "x"),
			},
		);
	});
});

describe("rememberMainPaneMove", () =>
{
	it("records the location left when the main pane zooms elsewhere, capped, and clears forward", () =>
	{
		const full: MainPaneHistory =
		{
			back: Array.from(
				{
					length: BACK_STACK_CAP,
				},
				(_, index) => loc(`n${index}`),
			),
			forward: [loc("f")],
		};
		const next = rememberMainPaneMove(full, loc("a", "x"), loc("b"));
		expect(
			{
				length: next.back.length,
				first: next.back[0],
				last: next.back.at(-1),
				forward: next.forward,
			},
		).toStrictEqual(
			{
				length: BACK_STACK_CAP,
				first: loc("n1"),
				last: loc("a", "x"),
				forward: [],
			},
		);
	});

	it("ignores a search-only change, a move from nowhere and staying put", () =>
	{
		const history: MainPaneHistory =
		{
			back: [loc("z")],
			forward: [loc("f")],
		};
		expect([
			rememberMainPaneMove(history, loc("a"), loc("a", "x")),
			rememberMainPaneMove(history, null, loc("a")),
			rememberMainPaneMove(history, loc("a"), loc("a")),
		]).toStrictEqual([history, history, history]);
	});
});

describe("stepMainPaneHistory", () =>
{
	const history: MainPaneHistory =
	{
		back: [loc("a"), loc("b")],
		forward: [loc("d"), loc("e")],
	};

	it("back takes the last back location and puts the current one first on forward", () =>
	{
		expect(stepMainPaneHistory(history, loc("c"), "back")).toStrictEqual(
			{
				target: loc("b"),
				history:
				{
					back: [loc("a")],
					forward: [loc("c"), loc("d"), loc("e")],
				},
			},
		);
	});

	it("forward takes the first forward location and appends the current one to back", () =>
	{
		expect(stepMainPaneHistory(history, loc("c"), "forward")).toStrictEqual(
			{
				target: loc("d"),
				history:
				{
					back: [loc("a"), loc("b"), loc("c")],
					forward: [loc("e")],
				},
			},
		);
	});

	it("is null on an empty stack or with no current location", () =>
	{
		expect([
			stepMainPaneHistory(emptyMainPaneHistory, loc("c"), "back"),
			stepMainPaneHistory(emptyMainPaneHistory, loc("c"), "forward"),
			stepMainPaneHistory(history, null, "back"),
		]).toStrictEqual([null, null, null]);
	});
});
