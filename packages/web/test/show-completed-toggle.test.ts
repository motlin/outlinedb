import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {processCombo} from "../src/client/keys/dispatch.js";
import {runShowCompletedToggle, showCompletedCommand} from "../src/client/show-completed-toggle.js";
import type {ShowCompletedToggleInput} from "../src/client/show-completed-toggle.js";

type Call = [string, ...unknown[]];

function harness(
	input: Pick<ShowCompletedToggleInput, "showCompleted" | "editingId"> &
	{
		shown: string[];
		hidden: string[];
		completed: string[];
	},
):
{
	input: ShowCompletedToggleInput;
	calls: Call[];
}
{
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]): void =>
		{
			calls.push([name, ...args]);
		};
	return {
		calls,
		input:
		{
			showCompleted: input.showCompleted,
			editingId: input.editingId,
			rowsFor: (showCompleted) => (showCompleted ? input.shown : input.hidden),
			isCompleted: (id) => input.completed.includes(id),
			actions:
			{
				setShowCompleted: record("setShowCompleted"),
				beginCompletionAnimation: record("beginCompletionAnimation"),
				startCompletionSlideUp: record("startCompletionSlideUp"),
				endCompletionAnimation: record("endCompletionAnimation"),
				startCompletedSlideDown: record("startCompletedSlideDown"),
				endCompletedSlideDown: record("endCompletedSlideDown"),
				resumeEditing: record("resumeEditing"),
			},
		},
	};
}

beforeEach(() =>
{
	vi.useFakeTimers();
});

afterEach(() =>
{
	vi.useRealTimers();
});

describe("runShowCompletedToggle", () =>
{
	it("hides: slides up the hidden done rows, moves the caret off a hidden row, then ends the slide", () =>
	{
		const {input, calls} = harness(
			{
				showCompleted: true,
				editingId: "b-child",
				shown: ["zoom", "a", "b", "b-child", "c"],
				hidden: ["zoom", "a", "c"],
				completed: ["b"],
			},
		);
		runShowCompletedToggle(input);
		const beforeTimer = [...calls];
		vi.advanceTimersByTime(220);
		expect(
			{
				beforeTimer,
				after: calls.slice(beforeTimer.length),
			},
		).toStrictEqual(
			{
				beforeTimer: [
					["beginCompletionAnimation", ["b"]],
					["setShowCompleted", false],
					["resumeEditing", "a", 0],
					["startCompletionSlideUp", ["b"]],
				],
				after: [["endCompletionAnimation", ["b"]]],
			},
		);
	});

	it("hides with the caret on a visible row and slides at most 10 rows", () =>
	{
		const done = Array.from(
			{
				length: 12,
			},
			(_, index) => `d${index}`,
		);
		const {input, calls} = harness(
			{
				showCompleted: true,
				editingId: "a",
				shown: ["a", ...done],
				hidden: ["a"],
				completed: done,
			},
		);
		runShowCompletedToggle(input);
		expect(calls).toStrictEqual([
			["beginCompletionAnimation", done.slice(0, 10)],
			["setShowCompleted", false],
			["startCompletionSlideUp", done.slice(0, 10)],
		]);
	});

	it("shows: reveals the rows, then slides down the newly visible done rows", () =>
	{
		const {input, calls} = harness(
			{
				showCompleted: false,
				editingId: null,
				shown: ["a", "b", "b-child", "c"],
				hidden: ["a", "c"],
				completed: ["b"],
			},
		);
		runShowCompletedToggle(input);
		const beforeTimer = [...calls];
		vi.advanceTimersByTime(220);
		expect(
			{
				beforeTimer,
				after: calls.slice(beforeTimer.length),
			},
		).toStrictEqual(
			{
				beforeTimer: [
					["setShowCompleted", true],
					["startCompletedSlideDown", ["b"]],
				],
				after: [["endCompletedSlideDown", ["b"]]],
			},
		);
	});
});

describe("showCompletedCommand", () =>
{
	const ctx =
	{
		items: ["alice-uuid"],
		zoomedId: null,
	};

	function press(
		combo: string,
		isMac: boolean,
		searching: boolean,
	):
	{
		result: string;
		toggles: number;
	}
	{
		let toggles = 0;
		const command = showCompletedCommand(
			() =>
			{
				toggles++;
			},
			() => searching,
		);
		const result = processCombo(
			combo,
			{
				show_or_hide_completed: command,
			},
			ctx,
			isMac,
		);
		return {
			result,
			toggles,
		};
	}

	it("toggles on Cmd+O while editing and on Ctrl+O off mac", () =>
	{
		expect(
			{
				mac: press("meta+o", true, false),
				other: press("ctrl+o", false, false),
			},
		).toStrictEqual(
			{
				mac:
				{
					result: "claimed",
					toggles: 1,
				},
				other:
				{
					result: "claimed",
					toggles: 1,
				},
			},
		);
	});

	it("claims Cmd+O and Ctrl+O without toggling while a search is in progress", () =>
	{
		expect(
			{
				mac: press("meta+o", true, true),
				other: press("ctrl+o", false, true),
			},
		).toStrictEqual(
			{
				mac:
				{
					result: "claimed",
					toggles: 0,
				},
				other:
				{
					result: "claimed",
					toggles: 0,
				},
			},
		);
	});
});
