import {readFileSync} from "node:fs";
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
const {projectClassName} = await import("../src/client/components/row-classes.js");

const movingIds = () => useOutlineStore.getState().movingIds;

describe("flashMoving", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
		useOutlineStore.setState(
			{
				movingIds: [],
			},
		);
	});

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("marks the moved row for 500ms", () =>
	{
		useOutlineStore.getState().flashMoving(["a"]);
		const start = movingIds();
		vi.advanceTimersByTime(499);
		const waiting = movingIds();
		vi.advanceTimersByTime(1);
		expect(
			{
				start,
				waiting,
				done: movingIds(),
			},
		).toStrictEqual(
			{
				start: ["a"],
				waiting: ["a"],
				done: [],
			},
		);
	});

	it("restarts the 500ms for a second move of several rows", () =>
	{
		useOutlineStore.getState().flashMoving(["a"]);
		vi.advanceTimersByTime(200);
		useOutlineStore.getState().flashMoving(["b", "c"]);
		const restarted = movingIds();
		vi.advanceTimersByTime(499);
		const waiting = movingIds();
		vi.advanceTimersByTime(1);
		expect(
			{
				restarted,
				waiting,
				done: movingIds(),
			},
		).toStrictEqual(
			{
				restarted: ["b", "c"],
				waiting: ["b", "c"],
				done: [],
			},
		);
	});
});

describe("moving row class", () =>
{
	it("adds moving to the moved .project", () =>
	{
		expect(
			projectClassName(
				{
					hasChildren: false,
					expanded: false,
					completed: false,
					hasNote: false,
					noteFocused: false,
					isZoomRoot: false,
					hasMirrors: false,
					highlighted: false,
					addedToSelection: false,
					moving: true,
				},
			),
		).toBe("font-custom project task moving");
	});

	it("styles .project.moving:before with upstream's selection rule", () =>
	{
		const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8")
			.replaceAll(/\s+/gu, "")
			.replaceAll(";}", "}");
		expect(
			{
				rule: css.includes(
					'.project.highlighted:before,.project.floating-conversations:before,.project.moving:before,.project.tapped:before{content:"";display:block;position:absolute;top:0;right:var(--item-selection-x-offset);bottom:0;left:var(--item-selection-x-offset);border-radius:var(--item-selection-border-radius);background:var(--wf-background-tertiary)}',
				),
				offset: css.includes("--item-selection-x-offset:-5px;"),
				radius: css.includes("--item-selection-border-radius:5px;"),
			},
		).toStrictEqual(
			{
				rule: true,
				offset: true,
				radius: true,
			},
		);
	});
});
