// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const NODE_UUID = "00000000-0000-0000-0000-0123456789ab";
const navigate = vi.fn<() => void>();
const goToNode = vi.fn<(...args: unknown[]) => void>();
const navigateToSearch = vi.fn<(...args: unknown[]) => void>();
const stopEditing = vi.fn<() => void>();
const resumeEditing = vi.fn<(...args: unknown[]) => void>();

vi.mock("../src/client/hooks/use-stable-navigate.js", () => (
{
	useStableNavigate: () => navigate,
}));
vi.mock("../src/client/navigation.js", () => (
{
	goToNode,
	navigateToSearch,
}));
vi.mock("../src/client/after-paint.js", () => (
{
	afterNextPaint: async () => Promise.resolve(),
}));
vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => (
	{
		query: async ({queryFn}: {queryFn: () => Promise<string | null>}) => queryFn(),
	}),
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => (
		{
			stopEditing,
			resumeEditing,
			zoomedNodeId: NODE_UUID,
			panes: [],
			activePaneId: "main",
		}),
	},
	activeZoomedId: () => NODE_UUID,
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {useContentLinkClicks} = await import("../src/client/hooks/use-content-link-clicks.js");

let root: Root | undefined;
let host: HTMLElement | undefined;
const resolveId = vi.fn<(id: string) => Promise<string | null>>(async (id) =>
	Promise.resolve(id === "0123456789ab" ? NODE_UUID : null),
);

function Harness(): null
{
	useContentLinkClicks(resolveId);
	return null;
}

function link(href: string, className = "contentLink"): HTMLAnchorElement
{
	const content = document.createElement("div");
	content.className = "content";
	const anchor = document.createElement("a");
	if (className !== "")
	{
		anchor.className = className;
	}
	anchor.setAttribute("href", href);
	anchor.textContent = "x";
	content.append(anchor);
	document.body.append(content);
	return anchor;
}

function fire(target: Element, type: string, init: MouseEventInit = {}): MouseEvent
{
	const event = new MouseEvent(
		type,
		{
			bubbles: true,
			cancelable: true,
			button: 0,
			...init,
		},
	);
	target.dispatchEvent(event);
	return event;
}

const flush = async () =>
	act(
		async () =>
			new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 0);
			}),
	);

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () =>
{
	vi.clearAllMocks();
	vi.spyOn(window, "open").mockImplementation(() => null);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(createElement(Harness));
		await Promise.resolve();
	});
});

afterEach(async () =>
{
	vi.restoreAllMocks();
	await act(async () =>
	{
		root?.unmount();
		await Promise.resolve();
	});
	document.body.replaceChildren();
});

describe("useContentLinkClicks main-pane routing", () =>
{
	it("prevents mousedown on a link so the row never enters edit mode", () =>
	{
		const event = fire(link("https://workflowy.com/#/0123456789ab"), "mousedown");
		expect(event.defaultPrevented).toBe(true);
	});

	it("navigates in-app on a plain click, without opening a tab", async () =>
	{
		const event = fire(link("https://workflowy.com/#/0123456789ab"), "click");
		await flush();
		expect(
			{
				prevented: event.defaultPrevented,
				goToNode: goToNode.mock.calls,
				open: vi.mocked(window.open).mock.calls,
				resumed: resumeEditing.mock.calls,
			},
		).toStrictEqual(
			{
				prevented: true,
				goToNode: [[navigate, NODE_UUID, null]],
				open: [],
				resumed: [[NODE_UUID, 0]],
			},
		);
	});

	it("handles a bare editor anchor with no contentLink class the same way", async () =>
	{
		fire(link("https://workflowy.com/#/0123456789ab", ""), "click");
		await flush();
		expect(goToNode.mock.calls).toStrictEqual([[navigate, NODE_UUID, null]]);
	});

	it("sends an unresolvable id Home", async () =>
	{
		fire(link("https://workflowy.com/#/000000000abc"), "click");
		await flush();
		expect(goToNode.mock.calls).toStrictEqual([[navigate, null, null]]);
	});

	it("runs a search: link as a search", async () =>
	{
		fire(link("search:%23foo"), "click");
		await flush();
		expect(
			{
				search: navigateToSearch.mock.calls,
				goToNode: goToNode.mock.calls,
			},
		).toStrictEqual(
			{
				search: [[navigate, "#foo"]],
				goToNode: [],
			},
		);
	});

	it("opens an external link with window.open and cancels the native target=_blank", async () =>
	{
		const event = fire(link("https://example.com"), "click");
		await flush();
		expect(
			{
				prevented: event.defaultPrevented,
				open: vi.mocked(window.open).mock.calls,
			},
		).toStrictEqual(
			{
				prevented: true,
				open: [["https://example.com"]],
			},
		);
	});

	it("opens the href on a middle click (auxclick)", () =>
	{
		const event = fire(
			link("https://example.com/m"),
			"auxclick",
			{
				button: 1,
			},
		);
		expect(
			{
				prevented: event.defaultPrevented,
				open: vi.mocked(window.open).mock.calls,
			},
		).toStrictEqual(
			{
				prevented: true,
				open: [["https://example.com/m"]],
			},
		);
	});
});
