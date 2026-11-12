import {describe, expect, it} from "vite-plus/test";
import {menuFocusStep, menuKeyboard} from "../src/client/components/flyout/menu-keyboard.js";
import type
{
	MenuFocusable,
	MenuFocusKey,
	MenuFocusStep,
	MenuKeyboardEvent,
	MenuKeyboardOptions,
	MenuKeyboardResult,
	MenuKeyboardState,
} from "../src/client/components/flyout/menu-keyboard.js";

const fresh: MenuKeyboardState =
{
	index: -1,
	hidden: false,
	keyboardMode: false,
};
const at = (index: number): MenuKeyboardState => (
{
	index,
	hidden: false,
	keyboardMode: true,
});
const defaults: MenuKeyboardOptions =
{
	count: 3,
	cyclic: false,
	selectOnTab: true,
	stopPropagation: false,
};
const key = (k: string, extra: Partial<MenuKeyboardEvent> = {}): MenuKeyboardEvent => (
{
	key: k,
	ctrlKey: false,
	shiftKey: false,
	composing: false,
	...extra,
});
const moved = (state: MenuKeyboardState, stopImmediate = false): MenuKeyboardResult => (
{
	state,
	action: "move",
	preventDefault: true,
	stopImmediate,
});
const selected = (state: MenuKeyboardState, preventDefault = true, stopImmediate = false): MenuKeyboardResult => (
{
	state,
	action: "select",
	preventDefault,
	stopImmediate,
});
const none = (state: MenuKeyboardState, preventDefault = false, stopImmediate = false): MenuKeyboardResult => (
{
	state,
	action: "none",
	preventDefault,
	stopImmediate,
});

const cases: [string, MenuKeyboardState, MenuKeyboardEvent, Partial<MenuKeyboardOptions>, MenuKeyboardResult][] = [
	["ArrowDown from -1 selects the first item", fresh, key("ArrowDown"), {}, moved(at(0))],
	[
		"Ctrl+N from -1 selects the first item",
		fresh,
		key(
			"n",
			{
				ctrlKey: true,
			},
		),
		{},
		moved(at(0)),
	],
	["ArrowDown advances", at(0), key("ArrowDown"), {}, moved(at(1))],
	["ArrowDown clamps at the last item", at(2), key("ArrowDown"), {}, moved(at(2))],
	[
		"cyclic ArrowDown wraps to the first item",
		at(2),
		key("ArrowDown"),
		{
			cyclic: true,
		},
		moved(at(0)),
	],
	["ArrowUp from -1 selects the last item", fresh, key("ArrowUp"), {}, moved(at(2))],
	[
		"Ctrl+P from -1 selects the last item",
		fresh,
		key(
			"p",
			{
				ctrlKey: true,
			},
		),
		{},
		moved(at(2)),
	],
	["ArrowUp moves back", at(2), key("ArrowUp"), {}, moved(at(1))],
	[
		"ArrowUp below 0 hides the selection",
		at(0),
		key("ArrowUp"),
		{},
		moved(
			{
				index: -1,
				hidden: true,
				keyboardMode: false,
			},
		),
	],
	[
		"cyclic ArrowUp wraps to the last item",
		at(0),
		key("ArrowUp"),
		{
			cyclic: true,
		},
		moved(at(2)),
	],
	[
		"count 0 ArrowDown highlights nothing (index 0 of no items)",
		fresh,
		key("ArrowDown"),
		{
			count: 0,
		},
		moved(at(0)),
	],
	[
		"count 0 ArrowUp from -1 hides",
		fresh,
		key("ArrowUp"),
		{
			count: 0,
		},
		moved(
			{
				index: -1,
				hidden: true,
				keyboardMode: true,
			},
		),
	],
	[
		"stopPropagation stops arrows when an item is selected",
		at(0),
		key("ArrowDown"),
		{
			stopPropagation: true,
		},
		moved(at(1), true),
	],
	[
		"stopPropagation does not stop arrows from -1",
		fresh,
		key("ArrowDown"),
		{
			stopPropagation: true,
		},
		moved(at(0)),
	],
	[
		"stopPropagation does not stop arrows while hidden",
		{
			index: 1,
			hidden: true,
			keyboardMode: true,
		},
		key("ArrowDown"),
		{
			stopPropagation: true,
		},
		moved(at(2)),
	],
	[
		"Ctrl+other key does nothing",
		at(0),
		key(
			"ArrowDown",
			{
				ctrlKey: true,
			},
		),
		{},
		none(at(0)),
	],
	[
		"composing ignores ArrowDown",
		at(0),
		key(
			"ArrowDown",
			{
				composing: true,
			},
		),
		{},
		none(at(0)),
	],
	[
		"composing ignores ArrowUp",
		at(1),
		key(
			"ArrowUp",
			{
				composing: true,
			},
		),
		{},
		none(at(1)),
	],
	["Enter selects the current index", at(1), key("Enter"), {}, selected(at(1))],
	[
		"Enter stops propagation when asked",
		at(1),
		key("Enter"),
		{
			stopPropagation: true,
		},
		selected(at(1), true, true),
	],
	["Enter at -1 does nothing", fresh, key("Enter"), {}, none(fresh)],
	[
		"composing ignores Enter",
		at(1),
		key(
			"Enter",
			{
				composing: true,
			},
		),
		{},
		none(at(1)),
	],
	["Tab selects by default", at(1), key("Tab"), {}, selected(at(1))],
	["Tab at -1 prevents default but selects nothing", fresh, key("Tab"), {}, none(fresh, true)],
	[
		"Tab without selectOnTab moves down",
		at(0),
		key("Tab"),
		{
			selectOnTab: false,
		},
		moved(at(1)),
	],
	[
		"Shift+Tab without selectOnTab moves up",
		at(1),
		key(
			"Tab",
			{
				shiftKey: true,
			},
		),
		{
			selectOnTab: false,
		},
		moved(at(0)),
	],
	[
		"Tab without selectOnTab stops propagation whenever asked",
		fresh,
		key("Tab"),
		{
			selectOnTab: false,
			stopPropagation: true,
		},
		moved(at(0), true),
	],
	[
		"composing ignores Tab",
		at(1),
		key(
			"Tab",
			{
				composing: true,
			},
		),
		{},
		none(at(1)),
	],
	["other keys do nothing", at(1), key("a"), {}, none(at(1))],
];

describe("menuKeyboard", () =>
{
	it.each(cases)("%s", (_name, state, event, opts, expected) =>
	{
		expect(
			menuKeyboard(
				state,
				event,
				{
					...defaults,
					...opts,
				},
			),
		).toStrictEqual(expected);
	});
});

describe("menuFocusStep", () =>
{
	// The date popup's order: input, three presets, a focus scope (header, day, last-row day), Range, Format.
	const items: MenuFocusable[] = [
		{
			menuItem: false,
		},
		{
			menuItem: true,
		},
		{
			menuItem: true,
		},
		{
			menuItem: true,
		},
		{
			menuItem: false,
			scope: 0,
		},
		{
			menuItem: false,
			scope: 0,
		},
		{
			menuItem: false,
			scope: 0,
			enterFromAfter: true,
		},
		{
			menuItem: true,
		},
		{
			menuItem: true,
		},
	];
	const focusCases: [string, number, number, MenuFocusKey, MenuFocusStep][] = [
		[
			"ArrowDown from the focused input selects the first row",
			0,
			-1,
			"ArrowDown",
			{
				kind: "select",
				menuIndex: 0,
			},
		],
		[
			"ArrowDown between rows is a plain move",
			-1,
			0,
			"ArrowDown",
			{
				kind: "move",
			},
		],
		[
			"ArrowDown from the last preset focuses the first scope button",
			-1,
			2,
			"ArrowDown",
			{
				kind: "focus",
				index: 4,
			},
		],
		[
			"ArrowDown from inside a scope selects the row after it",
			5,
			-1,
			"ArrowDown",
			{
				kind: "select",
				menuIndex: 3,
			},
		],
		[
			"ArrowDown from the last row is a plain move",
			-1,
			4,
			"ArrowDown",
			{
				kind: "move",
			},
		],
		[
			"ArrowUp into a scope focuses its enter-from-after button",
			-1,
			3,
			"ArrowUp",
			{
				kind: "focus",
				index: 6,
			},
		],
		[
			"ArrowUp from inside a scope selects the row before it",
			4,
			-1,
			"ArrowUp",
			{
				kind: "select",
				menuIndex: 2,
			},
		],
		[
			"ArrowUp from the focused input does nothing",
			0,
			-1,
			"ArrowUp",
			{
				kind: "none",
			},
		],
		[
			"ArrowUp between rows is a plain move",
			-1,
			1,
			"ArrowUp",
			{
				kind: "move",
			},
		],
		[
			"Tab from the focused input selects the first row",
			0,
			-1,
			"Tab",
			{
				kind: "select",
				menuIndex: 0,
			},
		],
		[
			"Tab from the last preset focuses the next button",
			-1,
			2,
			"Tab",
			{
				kind: "focus",
				index: 4,
			},
		],
		[
			"Tab inside a scope focuses the next button",
			4,
			-1,
			"Tab",
			{
				kind: "focus",
				index: 5,
			},
		],
		[
			"Shift+Tab from a scope button selects the row before it",
			4,
			-1,
			"ShiftTab",
			{
				kind: "select",
				menuIndex: 2,
			},
		],
		[
			"Tab with nothing focused focuses the input",
			-1,
			-1,
			"Tab",
			{
				kind: "focus",
				index: 0,
			},
		],
		[
			"Tab past the end does nothing",
			-1,
			4,
			"Tab",
			{
				kind: "none",
			},
		],
	];
	it.each(focusCases)("%s", (_name, focused, selectedRow, step, expected) =>
	{
		expect(menuFocusStep(items, focused, selectedRow, step, false)).toStrictEqual(expected);
	});

	it("wraps Tab past the end when cyclic", () =>
	{
		expect(menuFocusStep(items, -1, 4, "Tab", true)).toStrictEqual(
			{
				kind: "focus",
				index: 0,
			},
		);
	});
});
