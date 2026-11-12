import {describe, expect, it, vi} from "vite-plus/test";
import
{
	emitSwitcherStep,
	nearScrollEnd,
	onSwitcherStep,
	stepSelection,
	switcherCommandAction,
	switcherKeyAction,
	switcherStepCommand,
} from "../src/client/switcher-keys.js";

describe("switcherKeyAction", () =>
{
	it("maps the input's keys to upstream's switcher actions on mac", () =>
	{
		expect(
			[
				{
					key: "ArrowDown",
				},
				{
					key: "n",
					ctrlKey: true,
				},
				{
					key: "ArrowUp",
				},
				{
					key: "p",
					ctrlKey: true,
				},
				{
					key: "Enter",
				},
				{
					key: "Escape",
				},
				{
					key: "a",
				},
				{
					key: "n",
				},
				{
					key: "n",
					ctrlKey: true,
					shiftKey: true,
				},
				{
					key: "n",
					ctrlKey: true,
					metaKey: true,
				},
			].map((event) => switcherKeyAction(event, true)),
		).toStrictEqual(["next", "next", "prev", "prev", "enter", "close", null, null, null, null]);
	});

	it("leaves Ctrl+N and Ctrl+P to the browser off mac", () =>
	{
		expect(
			[
				{
					key: "n",
					ctrlKey: true,
				},
				{
					key: "p",
					ctrlKey: true,
				},
				{
					key: "ArrowDown",
				},
			].map((event) => switcherKeyAction(event, false)),
		).toStrictEqual([null, null, "next"]);
	});
});

describe("stepSelection", () =>
{
	it("wraps at both ends and stays at 0 with no rows", () =>
	{
		expect([
			stepSelection(0, 3, "next"),
			stepSelection(2, 3, "next"),
			stepSelection(0, 3, "prev"),
			stepSelection(2, 3, "prev"),
			stepSelection(0, 0, "next"),
			stepSelection(0, 0, "prev"),
		]).toStrictEqual([1, 0, 2, 1, 0, 0]);
	});
});

describe("nearScrollEnd", () =>
{
	it("is true within 300px of the bottom", () =>
	{
		expect([
			nearScrollEnd(
				{
					scrollTop: 0,
					scrollHeight: 1000,
					clientHeight: 600,
				},
			),
			nearScrollEnd(
				{
					scrollTop: 100,
					scrollHeight: 1000,
					clientHeight: 600,
				},
			),
			nearScrollEnd(
				{
					scrollTop: 101,
					scrollHeight: 1000,
					clientHeight: 600,
				},
			),
		]).toStrictEqual([false, false, true]);
	});
});

describe("switcherStepCommand", () =>
{
	it("opens the switcher when closed and steps the open switcher otherwise", () =>
	{
		const open = vi.fn<() => void>();
		const steps: string[] = [];
		const unsubscribe = onSwitcherStep((direction) =>
		{
			steps.push(direction);
		});
		const next = switcherStepCommand("next", () => false, open);
		const prev = switcherStepCommand("prev", () => true, open);
		next.execute(
			{
				items: [],
				zoomedId: null,
			},
		);
		prev.execute(
			{
				items: [],
				zoomedId: null,
			},
		);
		unsubscribe();
		emitSwitcherStep("next");
		expect(
			{
				opens: open.mock.calls.length,
				steps,
			},
		).toStrictEqual(
			{
				opens: 1,
				steps: ["prev"],
			},
		);
	});
});

describe("switcherCommandAction", () =>
{
	it("only opens: with the switcher open it changes nothing", () =>
	{
		expect([switcherCommandAction(true), switcherCommandAction(false)]).toStrictEqual(["none", "open"]);
	});
});
