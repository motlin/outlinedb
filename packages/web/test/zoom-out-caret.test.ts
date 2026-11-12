// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {StableNavigateProvider} from "../src/client/hooks/use-stable-navigate.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const calls: [string, string | null][] = [];

vi.mock("../src/client/zoom-animation.js", () => (
{
	zoomAnimationEnabled: () => true,
	ZOOMING_CLASS: "item--zooming-in-progress",
	waitForZoomRow: async () =>
	{
	},
	runZoomAnimation: vi.fn<() => Promise<void>>(async () =>
	{
		calls.push(["animate", useOutlineStore.getState().editingId]);
		return Promise.resolve();
	}),
}));

const {useZoomTo} = await import("../src/client/hooks/use-zoom-to.js");

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";

function row(id: string, parentId: string | null): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 100,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: true,
	};
}

let root: Root | undefined;
let unsubscribe: (() => void) | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	calls.length = 0;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 0));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Promise.resolve(
				Response.json(
					{
						rootId: null,
						items: [],
						lists: [],
					},
				),
			),
		),
	);
});

afterEach(() =>
{
	unsubscribe?.();
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

describe("zoom out caret", () =>
{
	it("edits the zoomed-out-of row only after the zoom-out animation", async () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [row(ALICE, null)]);
		queryClient.setQueryData(nodeKeys.children(ALICE), [row(BOB, ALICE)]);
		queryClient.setQueryData(nodeKeys.children(BOB), [row(CAROL, BOB)]);
		queryClient.setQueryData(nodeKeys.detail(ALICE), row(ALICE, null));
		queryClient.setQueryData(nodeKeys.detail(BOB), row(BOB, ALICE));
		useOutlineStore.setState(
			{
				zoomedNodeId: BOB,
				editingId: CAROL,
				editingCaretOffset: 0,
			},
		);
		unsubscribe = useOutlineStore.subscribe((state, previous) =>
		{
			if (state.editingId !== null && state.editingId !== previous.editingId)
			{
				calls.push(["edit", state.editingId]);
			}
		});
		const probe:
		{
			zoomTo?: ReturnType<typeof useZoomTo>;
		} = {};
		function Probe({capture}: {capture: (zoomTo: ReturnType<typeof useZoomTo>) => void})
		{
			capture(useZoomTo());
			return null;
		}
		root = createRoot(document.createElement("div"));
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(
						MemoryRouter,
						null,
						createElement(
							StableNavigateProvider,
							null,
							createElement(
								Probe,
								{
									capture: (zoomTo) =>
									{
										probe.zoomTo = zoomTo;
									},
								},
							),
						),
					),
				),
			);
		});

		await act(async () =>
		{
			await probe.zoomTo?.(null, "last_selected");
		});

		expect(
			{
				calls,
				editingId: useOutlineStore.getState().editingId,
				offset: useOutlineStore.getState().editingCaretOffset,
			},
		).toStrictEqual(
			{
				calls: [
					["animate", null],
					["edit", BOB],
				],
				editingId: BOB,
				offset: 0,
			},
		);
	});
});
