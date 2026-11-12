// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ALPHA = "00000000-0000-0000-0000-00000000000a";
const BRAVO = "00000000-0000-0000-0000-00000000000b";
const CHARLIE = "00000000-0000-0000-0000-00000000000c";

vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => (
	{
		query: async ({queryFn}: {queryFn: () => Promise<string | null>}) => queryFn(),
	}),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {usePaneClickRouting} = await import("../src/client/hooks/use-pane-click-routing.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;
const resolveId = vi.fn<(id: string) => Promise<string | null>>(async (id) =>
	Promise.resolve(id === "charlie" ? CHARLIE : null),
);

function Harness(): null
{
	usePaneClickRouting(resolveId);
	return null;
}

function paneOf(id: string): HTMLElement
{
	const pane = document.createElement("div");
	pane.dataset.paneId = id;
	document.body.append(pane);
	return pane;
}

function bullet(parent: HTMLElement, itemId: string, armed = true): HTMLElement
{
	const anchor = document.createElement("a");
	anchor.className = "bullet";
	anchor.dataset.handbook = "bullet.handle";
	anchor.dataset.itemId = itemId;
	if (armed)
	{
		anchor.dataset.preDragClick = "true";
	}
	parent.append(anchor);
	return anchor;
}

function crumb(parent: HTMLElement, itemId: string): HTMLElement
{
	const anchor = document.createElement("a");
	anchor.className = "breadcrumb-item";
	anchor.dataset.itemId = itemId;
	parent.append(anchor);
	return anchor;
}

function leftBarRow(href: string): HTMLElement
{
	const anchor = document.createElement("a");
	anchor.className = "left-bar-section-item";
	anchor.setAttribute("href", href);
	anchor.dataset.locationUrl = href;
	document.body.append(anchor);
	return anchor;
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent
{
	const event = new MouseEvent(
		"click",
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

const summary = () => (
{
	panes: useOutlineStore.getState().panes.map(({zoomedId, query}) => (
	{
		zoomedId,
		query,
	})),
	active: useOutlineStore.getState().activePaneId,
});

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () =>
{
	useOutlineStore.setState(
		{
			panes: [],
			activePaneId: "main",
			mainPaneUrlId: null,
		},
	);
	const host = document.createElement("div");
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
	await act(async () =>
	{
		root?.unmount();
		await Promise.resolve();
	});
	document.body.replaceChildren();
});

describe("usePaneClickRouting", () =>
{
	it("opens a pane from an armed main-pane bullet on alt-click", () =>
	{
		const event = click(
			bullet(paneOf("main"), ALPHA),
			{
				altKey: true,
			},
		);
		expect(
			{
				prevented: event.defaultPrevented,
				...summary(),
			},
		).toStrictEqual(
			{
				prevented: true,
				panes: [
					{
						zoomedId: ALPHA,
						query: "",
					},
				],
				active: useOutlineStore.getState().panes[0]?.id,
			},
		);
	});

	it("opens right after the bullet's own pane", () =>
	{
		useOutlineStore.getState().openPane(BRAVO);
		const first = useOutlineStore.getState().panes[0]?.id ?? "";
		useOutlineStore.getState().openPane(CHARLIE);
		click(
			bullet(paneOf(first), ALPHA),
			{
				altKey: true,
			},
		);
		expect(summary().panes).toStrictEqual([
			{
				zoomedId: BRAVO,
				query: "",
			},
			{
				zoomedId: ALPHA,
				query: "",
			},
			{
				zoomedId: CHARLIE,
				query: "",
			},
		]);
	});

	it("ignores an unarmed bullet, alt-shift and a plain click", () =>
	{
		const target = bullet(paneOf("main"), ALPHA, false);
		const armed = bullet(paneOf("main"), ALPHA);
		const events = [
			click(
				target,
				{
					altKey: true,
				},
			),
			click(
				armed,
				{
					altKey: true,
					shiftKey: true,
				},
			),
			click(armed),
		];
		expect(
			{
				prevented: events.map((event) => event.defaultPrevented),
				...summary(),
			},
		).toStrictEqual(
			{
				prevented: [false, false, false],
				panes: [],
				active: "main",
			},
		);
	});

	it("opens a Home pane from the Home crumb", () =>
	{
		const event = click(
			crumb(paneOf("main"), "None"),
			{
				altKey: true,
			},
		);
		expect(
			{
				prevented: event.defaultPrevented,
				panes: summary().panes,
			},
		).toStrictEqual(
			{
				prevented: true,
				panes: [
					{
						zoomedId: null,
						query: "",
					},
				],
			},
		);
	});

	it("leaves a plain crumb click alone", () =>
	{
		const event = click(crumb(paneOf("main"), ALPHA));
		expect(
			{
				prevented: event.defaultPrevented,
				panes: summary().panes,
			},
		).toStrictEqual(
			{
				prevented: false,
				panes: [],
			},
		);
	});

	it("appends a pane with the row's search query on alt-click of a left-bar row", async () =>
	{
		useOutlineStore.getState().openPane(BRAVO);
		const event = click(
			leftBarRow("/#/charlie?q=date%3Apast"),
			{
				altKey: true,
			},
		);
		await flush();
		expect(
			{
				prevented: event.defaultPrevented,
				panes: summary().panes,
			},
		).toStrictEqual(
			{
				prevented: true,
				panes: [
					{
						zoomedId: BRAVO,
						query: "",
					},
					{
						zoomedId: CHARLIE,
						query: "date:past",
					},
				],
			},
		);
	});

	it("navigates the active pane on a plain left-bar click while panes are open", async () =>
	{
		const paneId = useOutlineStore.getState().openPane(BRAVO);
		paneOf(paneId);
		const event = click(leftBarRow("/#/charlie"));
		await flush();
		expect(
			{
				prevented: event.defaultPrevented,
				...summary(),
			},
		).toStrictEqual(
			{
				prevented: true,
				panes: [
					{
						zoomedId: CHARLIE,
						query: "",
					},
				],
				active: paneId,
			},
		);
	});

	it("does not claim a plain left-bar click with no panes open", async () =>
	{
		const event = click(leftBarRow("/#/charlie"));
		await flush();
		expect(
			{
				prevented: event.defaultPrevented,
				panes: summary().panes,
			},
		).toStrictEqual(
			{
				prevented: false,
				panes: [],
			},
		);
	});
});
