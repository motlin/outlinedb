import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {NodeResponse} from "../src/node-types.js";
import type * as ExpansionsModule from "../src/client/stores/left-bar-expansions.js";

const storeState =
{
	zoomedNodeId: null as string | null,
	showCompleted: false,
	draggingIds: [] as string[],
	starDragActive: false,
};
const expansionState =
{
	keys: new Set<string>(),
	toggle: vi.fn<(key: string) => void>(),
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof storeState) => unknown) =>
		selector === undefined ? storeState : selector(storeState),
}));
vi.mock("../src/client/stores/left-bar-expansions.js", async (importActual) => (
{
	...(await importActual<typeof ExpansionsModule>()),
	useLeftBarExpansionStore: (selector: (state: typeof expansionState) => unknown) => selector(expansionState),
}));
vi.mock("../src/client/hooks/use-preferences.js", () => (
{
	useDateSettings: () => (
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		weekStartDay: 0,
	}),
}));
vi.mock("../src/client/hooks/use-calendar-settings.js", () => (
{
	useDayPrefix: () => true,
}));
vi.mock("react-router-dom", () => (
{
	useNavigate: () => () =>
	{
	},
}));

function node(id: string, name: string, overrides: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: null,
		name,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: true,
		...overrides,
	};
}

const children: Record<string, NodeResponse[]> =
{
	root: [
		node("A", '<span class="colored c-blue">A</span>'),
		node(
			"B",
			"B",
			{
				completedAt: 1,
			},
		),
		node(
			"C",
			"",
			{
				hasChildren: false,
			},
		),
	],
	A: [
		node(
			"A1",
			"A1",
			{
				hasChildren: false,
			},
		),
	],
	days: [
		node(
			"D",
			'<time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time>',
			{
				hasChildren: false,
				calendar:
				{
					level: "day",
					dateId: toDateId(new Date()),
				},
			} as Partial<NodeResponse>,
		),
		node(
			"E",
			'<time startYear="2026" startMonth="10" startDay="23">Fri, Oct 23, 2026</time>',
			{
				hasChildren: false,
			},
		),
	],
};

function toDateId(date: Date): number
{
	return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useChildren: (id: string | null) => (
	{
		data: id === null ? undefined : children[id],
	}),
}));

const {FilesListRows} = await import("../src/client/components/left-bar-files-list.js");
const {leftBarExpansionKey, pageUniqueId} = await import("../src/client/stores/left-bar-expansions.js");
const {filesListArrow, nextLimit, renderLimit} = await import("../src/client/components/left-bar-files-list.js");

const homeKey = (top: string, id: string) => `leftbar__home__None/${top}/__${id}`;

function rows(): string[]
{
	const html = renderToStaticMarkup(
		createElement(
			FilesListRows,
			{
				parentId: "root",
				depth: 0,
				section: "home",
			},
		),
	);
	return html
		.split("<a ")
		.slice(1)
		.map((row) => `<a ${row}`);
}

function label(row: string): string
{
	return /<span class="innerContentContainer">(.*?)<\/span><\/span><\/div>/u.exec(row)?.[1] ?? "";
}

function anchorTag(row: string): string
{
	return row.slice(0, row.indexOf(">") + 1);
}

function innerTag(row: string): string
{
	const at = row.indexOf('<div class="flex grow');
	return row.slice(at, row.indexOf(">", at) + 1);
}

beforeEach(() =>
{
	storeState.zoomedNodeId = null;
	storeState.showCompleted = false;
	expansionState.keys = new Set();
	expansionState.toggle.mockClear();
});

describe("FilesListRows", () =>
{
	it("shows only live non-empty rows with raw name HTML when nothing is expanded", () =>
	{
		const result = rows();
		expect(
			{
				labels: result.map(label),
				anchor: anchorTag(result[0] ?? ""),
				inner: innerTag(result[0] ?? ""),
			},
		).toStrictEqual(
			{
				labels: ['<span class="colored c-blue">A</span>'],
				anchor: '<a href="/#/A" data-location-url="/#/A" draggable="false" class="flex justify-between items-center pr-m hover:cursor-pointer hover:no-underline left-bar-section-item font-custom " style="padding-left:12px;color:var(--wf-text-tertiary)">',
				inner: '<div class="flex grow items-center min-w-0 h-[30px] pl-xs text-tertiary" style="font-weight:400">',
			},
		);
	});

	it("renders expanded children flat with deeper padding and highlights the current node", () =>
	{
		expansionState.keys = new Set([homeKey("A", "A")]);
		storeState.zoomedNodeId = "A1";
		const result = rows();
		expect(
			result.map((row) => (
			{
				label: label(row),
				anchor: anchorTag(row),
				inner: innerTag(row),
				arrowExpanded: row.includes("arrow expanded"),
			})),
		).toStrictEqual([
			{
				label: '<span class="colored c-blue">A</span>',
				anchor: '<a href="/#/A" data-location-url="/#/A" draggable="false" class="flex justify-between items-center pr-m hover:cursor-pointer hover:no-underline left-bar-section-item font-custom " style="padding-left:12px;color:var(--wf-text-tertiary)">',
				inner: '<div class="flex grow items-center min-w-0 h-[30px] pl-xs text-tertiary" style="font-weight:400">',
				arrowExpanded: true,
			},
			{
				label: "A1",
				anchor: '<a href="/#/A1" data-location-url="/#/A1" draggable="false" class="flex justify-between items-center pr-m hover:cursor-pointer hover:no-underline left-bar-section-item font-custom " style="padding-left:24px;color:var(--wf-text-secondary)">',
				inner: '<div class="flex grow items-center min-w-0 h-[30px] pl-xs text-tertiary" style="font-weight:600">',
				arrowExpanded: false,
			},
		]);
	});

	it("shows completed rows struck through when show-completed is on", () =>
	{
		storeState.showCompleted = true;
		const result = rows();
		expect(
			{
				labels: result.map(label),
				anchor: anchorTag(result[1] ?? ""),
			},
		).toStrictEqual(
			{
				labels: ['<span class="colored c-blue">A</span>', "B"],
				anchor: '<a href="/#/B" data-location-url="/#/B" draggable="false" class="flex justify-between items-center pr-m hover:cursor-pointer hover:line-through left-bar-section-item font-custom " style="padding-left:12px;color:var(--wf-text-tertiary);text-decoration:line-through;opacity:0.5">',
			},
		);
	});
});

describe("rows while a drag carries one", () =>
{
	it("shows the grabbed row secondary, bold and dimmed, and the zoomed row as plain", () =>
	{
		expansionState.keys = new Set([homeKey("A", "A")]);
		storeState.zoomedNodeId = "A1";
		storeState.draggingIds = ["A"];
		const result = rows();
		storeState.draggingIds = [];
		expect(
			result.map((row) => (
			{
				style: /style="([^"]*)"/u.exec(row)?.[1],
				weight: /font-weight:(\d+)/u.exec(innerTag(row))?.[1],
			})),
		).toStrictEqual([
			{
				style: "padding-left:12px;color:var(--wf-text-secondary);opacity:0.3",
				weight: "600",
			},
			{
				style: "padding-left:24px;color:var(--wf-text-tertiary)",
				weight: "400",
			},
		]);
	});
});

describe("FilesListRows arrow opacity", () =>
{
	const originalRoot = children.root;
	afterEach(() =>
	{
		children.root = originalRoot;
	});

	function arrowStyle(row: string): string
	{
		return (
			/class="flex shrink-0 items-center justify-center opacity-\[var\(--opacity\)\][^"]*"[^>]*style="([^"]*)"/u.exec(
				row,
			)?.[1] ?? ""
		);
	}

	it("dims rows without visible children like upstream's noChildren and brightens the current row", () =>
	{
		children.root = [
			node("P", "P"),
			node(
				"L",
				"L",
				{
					hasChildren: false,
				},
			),
			node(
				"D",
				"D",
				{
					hasChildren: true,
					hasUncompletedChildren: false,
				},
			),
			node("Q", "Q"),
			node(
				"M",
				"M",
				{
					hasChildren: false,
				},
			),
		];
		storeState.zoomedNodeId = "Q";
		const current = rows().map(arrowStyle);
		storeState.zoomedNodeId = "M";
		const currentLeaf = rows().map(arrowStyle)[4];
		expect(
			{
				current,
				currentLeaf,
			},
		).toStrictEqual(
			{
				current: [
					"--opacity:0.45;--hover-opacity:1",
					"--opacity:0.15;--hover-opacity:0.45",
					"--opacity:0.15;--hover-opacity:0.45",
					"--opacity:0.65;--hover-opacity:1",
					"--opacity:0.15;--hover-opacity:0.45",
				],
				currentLeaf: "--opacity:0.2;--hover-opacity:0.65",
			},
		);
	});

	it("counts completed children once show-completed is on", () =>
	{
		children.root = [
			node(
				"D",
				"D",
				{
					hasChildren: true,
					hasUncompletedChildren: false,
				},
			),
		];
		storeState.showCompleted = true;
		expect(rows().map(arrowStyle)).toStrictEqual(["--opacity:0.45;--hover-opacity:1"]);
	});
});

describe("account-synced expansion keys", () =>
{
	it("builds upstream's key strings", () =>
	{
		const sandbox = "7aed376b-80c8-42c5-8065-ab03ee6d2ae0";
		expect(
			{
				row: leftBarExpansionKey("home", pageUniqueId(sandbox), sandbox),
				home: leftBarExpansionKey("starred", pageUniqueId(null), null),
			},
		).toStrictEqual(
			{
				row: "leftbar__home__None/7aed376b-80c8-42c5-8065-ab03ee6d2ae0/__7aed376b",
				home: "leftbar__starred__None/None/__None",
			},
		);
	});

	it("keeps a nested key dormant until its top row is expanded", () =>
	{
		const originalA = children.A;
		children.A = [
			node("A1", "A1"),
			node(
				"B1",
				"B1",
				{
					hasChildren: false,
				},
			),
		];
		children.A1 = [
			node(
				"A1a",
				"A1a",
				{
					hasChildren: false,
				},
			),
		];
		expansionState.keys = new Set([homeKey("A", "A1")]);
		const dormant = rows().map(label);
		expansionState.keys = new Set([homeKey("A", "A"), homeKey("A", "A1")]);
		const open = rows().map((row) => (
		{
			label: label(row),
			expanded: row.includes("arrow expanded"),
		}));
		children.A = originalA;
		expect(
			{
				dormant,
				open,
			},
		).toStrictEqual(
			{
				dormant: ['<span class="colored c-blue">A</span>'],
				open: [
					{
						label: '<span class="colored c-blue">A</span>',
						expanded: true,
					},
					{
						label: "A1",
						expanded: true,
					},
					{
						label: "A1a",
						expanded: false,
					},
					{
						label: "B1",
						expanded: false,
					},
				],
			},
		);
	});
});

describe("FilesListRows toggling", () =>
{
	function rowArrowOnClick(tree: unknown): (event: unknown) => void
	{
		const arrow = tree as
		{
			props:
			{
				onClick: (event: unknown) => void;
			};
		};
		return arrow.props.onClick;
	}

	it("swallows the click and toggles through onToggle", () =>
	{
		const click =
		{
			preventDefault: vi.fn<() => void>(),
			stopPropagation: vi.fn<() => void>(),
		};
		const onToggle = vi.fn<() => void>();
		rowArrowOnClick(
			filesListArrow(
				{
					expanded: false,
					noChildren: false,
					current: false,
					onToggle,
				},
			),
		)(click);
		expect(
			{
				toggled: onToggle.mock.calls.length,
				stopped: click.stopPropagation.mock.calls.length,
			},
		).toStrictEqual(
			{
				toggled: 1,
				stopped: 1,
			},
		);
	});
});

describe("FilesListRows windowing", () =>
{
	const originalRoot = children.root;
	afterEach(() =>
	{
		children.root = originalRoot;
	});

	function count(limit: number): number
	{
		return (
			renderToStaticMarkup(
				createElement(
					FilesListRows,
					{
						parentId: "root",
						depth: 0,
						section: "home",
						windowed: true,
						limit,
					},
				),
			).split("<a ").length - 1
		);
	}

	it("limits rows to the scroll window plus 100", () =>
	{
		children.root = Array.from(
			{
				length: 500,
			},
			(_, index) => node(`n${index}`, `n${index}`),
		);
		expect(
			{
				first: renderLimit(
					{
						scrollTop: 0,
						offsetHeight: 800,
						rulerOffsetTop: 100,
					},
				),
				scrolled: renderLimit(
					{
						scrollTop: 3200,
						offsetHeight: 800,
						rulerOffsetTop: 100,
					},
				),
				small: nextLimit(122, 150),
				big: nextLimit(122, 200),
				rendered: count(122),
			},
		).toStrictEqual(
			{
				first: 122,
				scrolled: 222,
				small: 122,
				big: 200,
				rendered: 122,
			},
		);
	});

	it("nested lists share the remaining budget", () =>
	{
		children.root = [node("A", "A")];
		children.A = Array.from(
			{
				length: 50,
			},
			(_, index) =>
				node(
					`a${index}`,
					`a${index}`,
					{
						hasChildren: false,
					},
				),
		);
		expansionState.keys = new Set([homeKey("A", "A")]);
		expect(count(11)).toBe(11);
	});
});

describe("FilesListRows date names", () =>
{
	it("renders a <time> name as a pill, with the friendly prefix only on a calendar day node", () =>
	{
		const result = renderToStaticMarkup(
			createElement(
				FilesListRows,
				{
					parentId: "days",
					depth: 0,
					section: "home",
				},
			),
		);
		const spans = [...result.matchAll(/(Today, )?<span style="pointer-events:none;white-space:nowrap">/gu)].map(
			(match) => match[1] || "",
		);
		expect(
			{
				spans,
				pills: result.match(/<span class="content-wrapper">[^<]*<\/span>/gu),
				raw: result.includes("Fri, Oct 23, 2026"),
			},
		).toStrictEqual(
			{
				spans: ["Today, ", ""],
				pills: [
					'<span class="content-wrapper">2026-10-23 Fri</span>',
					'<span class="content-wrapper">2026-10-23 Fri</span>',
				],
				raw: false,
			},
		);
	});
});
