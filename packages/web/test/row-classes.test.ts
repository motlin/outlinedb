import {describe, expect, it} from "vite-plus/test";
import {nameClassName, projectClassName} from "../src/client/components/row-classes.js";
import type {ProjectClassState} from "../src/client/components/row-classes.js";

const LEAF: ProjectClassState =
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
};

describe("projectClassName", () =>
{
	it("marks a plain leaf as a task", () =>
	{
		expect(projectClassName(LEAF)).toBe("font-custom project task");
	});

	it("marks an expanded parent as open", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: true,
					expanded: true,
				},
			),
		).toBe("font-custom project open");
	});

	it("marks a parent whose children are sliding down as open animatingShowChildren", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: true,
					expanded: true,
					animatingShowChildren: true,
				},
			),
		).toBe("font-custom project open animatingShowChildren");
	});

	it("marks a collapsed parent as collapsed", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: true,
				},
			),
		).toBe("font-custom project collapsed");
	});

	it("shows neither open nor collapsed while the children slide up", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: true,
					collapsingChildren: true,
				},
			),
		).toBe("font-custom project");
	});

	it("marks a parent whose children are hidden as a task that is open once expanded", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: false,
					hasAnyChildren: true,
					expanded: true,
				},
			),
		).toBe("font-custom project task open");
	});

	it("leaves a task with only hidden children closed while collapsed", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: false,
					hasAnyChildren: true,
				},
			),
		).toBe("font-custom project task");
	});

	it("marks a completed leaf with a note as done and noted", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					completed: true,
					hasNote: true,
				},
			),
		).toBe("font-custom project task done noted");
	});

	it("marks a leaf with a focused note as noted", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					noteFocused: true,
				},
			),
		).toBe("font-custom project task noted");
	});

	it("marks the expanded zoom root as selected root without open", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					hasChildren: true,
					expanded: true,
					isZoomRoot: true,
				},
			),
		).toBe("font-custom project selected root");
	});

	it("appends the layout class last", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					layoutClasses: ["checkmark"],
				},
			),
		).toBe("font-custom project task checkmark");
	});

	it("adds item--with-image after the layout classes for a previewable attachment", () =>
	{
		expect(
			projectClassName(
				{
					...LEAF,
					layoutClasses: ["paragraph"],
					withImage: true,
				},
			),
		).toBe("font-custom project task paragraph item--with-image");
	});

	it("emits every state class in upstream order", () =>
	{
		expect(
			projectClassName(
				{
					hasChildren: true,
					expanded: false,
					completed: true,
					hasNote: true,
					noteFocused: false,
					isZoomRoot: false,
					hasMirrors: true,
					highlighted: true,
					addedToSelection: true,
					layoutClasses: ["board"],
				},
			),
		).toBe("font-custom project hasMirrors done noted collapsed highlighted addedToSelection board");
	});
});

describe("projectClassName completion slideUp", () =>
{
	it("adds completing-slide-up while the completed row slides up", () =>
	{
		expect(
			projectClassName(
				{
					hasChildren: false,
					expanded: false,
					completed: true,
					hasNote: false,
					noteFocused: false,
					isZoomRoot: false,
					hasMirrors: false,
					highlighted: false,
					addedToSelection: false,
					slidingUp: true,
				},
			),
		).toBe("font-custom project task done completing-slide-up");
	});
});

describe("projectClassName completed slideDown", () =>
{
	it("adds completed-slide-down while a revealed completed row slides down", () =>
	{
		expect(
			projectClassName(
				{
					hasChildren: false,
					expanded: false,
					completed: true,
					hasNote: false,
					noteFocused: false,
					isZoomRoot: false,
					hasMirrors: false,
					highlighted: false,
					addedToSelection: false,
					slidingDown: true,
				},
			),
		).toBe("font-custom project task done completed-slide-down");
	});
});

describe("nameClassName", () =>
{
	it("returns the bare name class by default", () =>
	{
		expect(nameClassName({})).toBe("name");
	});

	it("adds name--focused when focused", () =>
	{
		expect(
			nameClassName(
				{
					focused: true,
				},
			),
		).toBe("name name--focused");
	});

	it("adds name--main for the zoom root", () =>
	{
		expect(
			nameClassName(
				{
					isZoomRoot: true,
				},
			),
		).toBe("name name--main");
	});

	it("adds name--root for the main-tree root", () =>
	{
		expect(
			nameClassName(
				{
					isMainRoot: true,
				},
			),
		).toBe("name name--root");
	});

	it("adds empty for an empty name", () =>
	{
		expect(
			nameClassName(
				{
					empty: true,
				},
			),
		).toBe("name empty");
	});

	it("emits every name class in upstream order", () =>
	{
		expect(
			nameClassName(
				{
					focused: true,
					isZoomRoot: true,
					isMainRoot: true,
					empty: true,
				},
			),
		).toBe("name name--focused name--main name--root empty");
	});
});
