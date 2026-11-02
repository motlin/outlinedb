import {describe, expect, it} from "vite-plus/test";
import {menuKeyboard} from "../src/client/components/flyout/menu-keyboard.js";
import type {MenuKeyboardState} from "../src/client/components/flyout/menu-keyboard.js";
import {slashKeyAction, slashMode} from "../src/client/slash-menu-state.js";
import type {SlashKeyAction, SlashKeyInput} from "../src/client/slash-menu-state.js";

const input = (key: string, extra: Partial<SlashKeyInput> = {}): SlashKeyInput => (
{
	key,
	ctrlKey: false,
	metaKey: false,
	caretAtChipEnd: false,
	...extra,
});

describe("slashKeyAction", () =>
{
	it.each<[string, SlashKeyInput, SlashKeyAction | null]>([
		["ArrowDown", input("ArrowDown"), "down"],
		[
			"Ctrl+N",
			input(
				"n",
				{
					ctrlKey: true,
				},
			),
			"down",
		],
		["ArrowUp", input("ArrowUp"), "up"],
		[
			"Ctrl+P",
			input(
				"p",
				{
					ctrlKey: true,
				},
			),
			"up",
		],
		["Enter", input("Enter"), "select"],
		["Tab", input("Tab"), "select"],
		["Escape", input("Escape"), "abandon"],
		[
			"ArrowRight at chip end",
			input(
				"ArrowRight",
				{
					caretAtChipEnd: true,
				},
			),
			"abandon",
		],
		["ArrowRight inside chip", input("ArrowRight"), null],
		[
			"Meta+Z",
			input(
				"z",
				{
					metaKey: true,
				},
			),
			"disarmNoAbandon",
		],
		[
			"Ctrl+Z",
			input(
				"z",
				{
					ctrlKey: true,
				},
			),
			"disarmNoAbandon",
		],
		["plain z", input("z"), null],
		[
			"Ctrl+X",
			input(
				"x",
				{
					ctrlKey: true,
				},
			),
			null,
		],
	])("%s", (_name, event, expected) =>
	{
		expect(slashKeyAction(event)).toStrictEqual(expected);
	});
});

describe("slashMode", () =>
{
	const keyboardAt2: MenuKeyboardState =
	{
		index: 2,
		hidden: false,
		keyboardMode: true,
	};

	it("mouseMove leaves the index and enters mouse mode", () =>
	{
		expect(
			slashMode(
				keyboardAt2,
				{
					type: "mouseMove",
				},
			),
		).toStrictEqual(
			{
				index: 2,
				hidden: false,
				keyboardMode: false,
			},
		);
	});

	it("hover then ArrowDown continues from the hovered row in keyboard mode", () =>
	{
		const mouse = slashMode(
			keyboardAt2,
			{
				type: "mouseMove",
			},
		);
		const hovered = slashMode(
			mouse,
			{
				type: "hover",
				index: 4,
			},
		);
		expect(hovered).toStrictEqual(
			{
				index: 4,
				hidden: false,
				keyboardMode: false,
			},
		);
		const down = menuKeyboard(
			hovered,
			{
				key: "ArrowDown",
				ctrlKey: false,
				shiftKey: false,
				composing: false,
			},
			{
				count: 13,
				cyclic: true,
				selectOnTab: true,
				stopPropagation: true,
			},
		);
		expect(down.state).toStrictEqual(
			{
				index: 5,
				hidden: false,
				keyboardMode: true,
			},
		);
	});
});
