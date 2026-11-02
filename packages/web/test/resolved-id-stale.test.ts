// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement, useEffect} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, useLocation, useNavigate} from "react-router-dom";
import {RESOLVED_ID_STALE_TIME, nodeKeys} from "../src/client/node-cache.js";
import {useHashLocationZoom} from "../src/client/hooks/use-hash-location-zoom.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const CCC = "4823cefa-5fc0-478c-88ac-cccccccccccc";

let root: Root | undefined;
let requests: string[] = [];

/** Lets React commit between polls until the condition holds, instead of guessing how long the lookups take. */
async function settle(done: () => boolean): Promise<void>
{
	await vi.waitFor(async () =>
	{
		await act(async () =>
		{
			await new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 0);
			});
		});
		if (!done())
		{
			throw new Error("not settled");
		}
	});
}

function nodeBody(id: string): string
{
	return JSON.stringify(
		{
			node:
			{
				id,
				parent_id: null,
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
			},
		},
	);
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	requests = [];
	let lookups = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
		{
			requests.push(url);
			if (url === "/api/v1/nodes/cccccccccccc")
			{
				lookups += 1;
				return Promise.resolve(
					lookups === 1
						? new Response(
								"{}",
								{
									status: 404,
								},
							)
						: new Response(
								nodeBody(CCC),
								{
									status: 200,
								},
							),
				);
			}
			return Promise.resolve(
				new Response(
					"{}",
					{
						status: 404,
					},
				),
			);
		}),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

describe("RESOLVED_ID_STALE_TIME", () =>
{
	it("refetches a null resolution and keeps a string one", async () =>
	{
		const queryClient = new QueryClient();
		const queryFn = vi.fn<() => Promise<string>>(async () => Promise.resolve(CCC));
		queryClient.setQueryData(nodeKeys.resolvedId("cccccccccccc"), null);
		const refetched = await queryClient.query(
			{
				queryKey: nodeKeys.resolvedId("cccccccccccc"),
				queryFn,
				staleTime: RESOLVED_ID_STALE_TIME,
			},
		);
		const kept = await queryClient.query(
			{
				queryKey: nodeKeys.resolvedId("cccccccccccc"),
				queryFn,
				staleTime: RESOLVED_ID_STALE_TIME,
			},
		);
		expect(
			{
				refetched,
				kept,
				calls: queryFn.mock.calls.length,
			},
		).toStrictEqual(
			{
				refetched: CCC,
				kept: CCC,
				calls: 1,
			},
		);
	});
});

describe("useHashLocationZoom with a 404 that later resolves", () =>
{
	it("re-resolves on the next navigation without bouncing to Home", async () =>
	{
		const seen: string[] = [];
		const nav:
		{
			go: (url: string) => void;
		} =
		{
			go: () =>
			{
			},
		};
		function Probe()
		{
			useHashLocationZoom();
			const location = useLocation();
			const navigate = useNavigate();
			useEffect(() =>
			{
				nav.go = (url) => void navigate(url);
			}, [navigate]);
			useEffect(() =>
			{
				seen.push(location.pathname + location.hash);
			}, [location]);
			return null;
		}
		const queryClient = new QueryClient();
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
						{
							initialEntries: ["/#/cccccccccccc"],
						},
						createElement(Probe),
					),
				),
			);
		});
		await settle(() => seen.length >= 2);
		const first =
		{
			zoomed: useOutlineStore.getState().zoomedNodeId,
			seen: [...seen],
		};
		act(() =>
		{
			nav.go("/#/cccccccccccc");
		});
		await settle(() => seen.length >= 3 && useOutlineStore.getState().zoomedNodeId === CCC);
		expect(
			{
				first,
				zoomed: useOutlineStore.getState().zoomedNodeId,
				seen,
				lookups: requests.filter((url) => url === "/api/v1/nodes/cccccccccccc").length,
			},
		).toStrictEqual(
			{
				first:
				{
					zoomed: null,
					seen: ["/#/cccccccccccc", "/"],
				},
				zoomed: CCC,
				seen: ["/#/cccccccccccc", "/", "/#/cccccccccccc"],
				lookups: 2,
			},
		);
	});
});
