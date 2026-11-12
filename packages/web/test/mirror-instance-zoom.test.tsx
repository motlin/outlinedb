// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter, useLocation} from "react-router-dom";
import type {NodeResponse} from "../src/node-types.js";
import
{
	cachedAncestors,
	cachedInstanceAncestors,
	cachedResolvedId,
	instanceAncestorsKey,
	nodeKeys,
} from "../src/client/node-cache.js";
import {useHashLocationZoom} from "../src/client/hooks/use-hash-location-zoom.js";
import {goToNode, resolveZoomTarget} from "../src/client/navigation.js";
import {locationUrl, parseLocationHash, shortId} from "../src/client/location.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ORIGINAL = "aaaa1111-0000-4000-8000-a0a0a0a0a0a0";
const CHILD = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
const GRANDCHILD = "5d5d5d5d-aaaa-4bbb-8ccc-0123456789ab";
const MIRROR = "0e9f8d7c-1111-4222-8333-d4f14a54f384";
const VIRTUAL = "v_c910f3eac9b3_d4f14a54f384_0e9f";
const INSTANCE =
{
	rootId: MIRROR,
	path: "0e9f",
};

function row(id: string, parentId: string | null, fields: Partial<NodeResponse> = {}): NodeResponse
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
		...fields,
	};
}

function seededClient(): QueryClient
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children(null), [
		row(ORIGINAL, null),
		row(
			MIRROR,
			null,
			{
				isMirror: true,
				originalNodeId: ORIGINAL,
			},
		),
	]);
	queryClient.setQueryData(nodeKeys.children(ORIGINAL), [row(CHILD, ORIGINAL)]);
	queryClient.setQueryData(nodeKeys.children(CHILD), [
		row(
			GRANDCHILD,
			CHILD,
			{
				hasChildren: false,
			},
		),
	]);
	return queryClient;
}

describe("virtual locations", () =>
{
	it("passes a v_ id through shortId and builds and parses its URL", () =>
	{
		expect(
			{
				short: shortId(VIRTUAL),
				url: locationUrl(
					{
						id: CHILD,
						instance: INSTANCE,
					},
				),
				kept: locationUrl(
					{
						id: VIRTUAL,
						query: "x",
					},
				),
				parsed: parseLocationHash(`#/${VIRTUAL}`).id,
			},
		).toStrictEqual(
			{
				short: VIRTUAL,
				url: `/#/${VIRTUAL}`,
				kept: `/#/${VIRTUAL}?q=x`,
				parsed: VIRTUAL,
			},
		);
	});

	it("resolves a v_ param to the child through the lookup", () =>
	{
		expect(resolveZoomTarget(VIRTUAL, (id) => (id === VIRTUAL ? CHILD : null))).toBe(CHILD);
	});

	it("resolves a v_ id from the cache by its child's short id", () =>
	{
		expect(cachedResolvedId(seededClient(), VIRTUAL)).toBe(CHILD);
	});
});

describe("cachedInstanceAncestors", () =>
{
	it("lists the mirror's ancestors and the mirror, then the chain below the original down to the row", () =>
	{
		const queryClient = seededClient();
		const chain = cachedInstanceAncestors(
			queryClient,
			GRANDCHILD,
			{
				rootId: MIRROR,
				path: "0e9f7b1c",
			},
		);

		expect(
			{
				instance: chain?.map((node) => node.id),
				plain: cachedAncestors(queryClient, GRANDCHILD)?.map((node) => node.id),
			},
		).toStrictEqual(
			{
				instance: [MIRROR, CHILD, GRANDCHILD],
				plain: [ORIGINAL, CHILD, GRANDCHILD],
			},
		);
	});

	it("leaves a row's plain chain alone once the instance chain is cached under its virtual id", () =>
	{
		const queryClient = seededClient();
		const chain = cachedInstanceAncestors(queryClient, GRANDCHILD, INSTANCE) ?? [];
		queryClient.setQueryData(nodeKeys.ancestors(instanceAncestorsKey(GRANDCHILD, INSTANCE)), chain);

		expect(cachedAncestors(queryClient, CHILD)?.map((node) => node.id)).toStrictEqual([ORIGINAL, CHILD]);
	});

	it("misses when the mirror is not cached", () =>
	{
		expect(cachedInstanceAncestors(new QueryClient(), CHILD, INSTANCE)).toBeUndefined();
	});
});

describe("zoom into a mirror instance", () =>
{
	let root: Root | undefined;
	let requests: string[] = [];

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		requests = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
			{
				requests.push(url);
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

	it("keeps the instance and the v_ URL when the hash names a row inside a mirror", () =>
	{
		const queryClient = seededClient();
		const navigations: string[] = [];
		function Probe()
		{
			useHashLocationZoom();
			navigations.push(useLocation().hash);
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
						{
							initialEntries: [`/#/${VIRTUAL}`],
						},
						createElement(Probe),
					),
				),
			);
		});
		const {zoomedNodeId, zoomedInstance} = useOutlineStore.getState();
		expect(
			{
				zoomedNodeId,
				zoomedInstance,
				navigations,
				requests,
			},
		).toStrictEqual(
			{
				zoomedNodeId: CHILD,
				zoomedInstance: INSTANCE,
				navigations: [`#/${VIRTUAL}`],
				requests: [],
			},
		);
	});

	it("goToNode zooms to the instance and pushes its v_ URL", () =>
	{
		const navigate = vi.fn<(url: string) => void>();
		goToNode(navigate, CHILD, null, false, INSTANCE);
		const {zoomedNodeId, zoomedInstance} = useOutlineStore.getState();
		expect(
			{
				zoomedNodeId,
				zoomedInstance,
				navigate: navigate.mock.calls,
			},
		).toStrictEqual(
			{
				zoomedNodeId: CHILD,
				zoomedInstance: INSTANCE,
				navigate: [[`/#/${VIRTUAL}`]],
			},
		);
	});

	it("zooming to a plain node clears the instance", () =>
	{
		useOutlineStore.getState().zoom(CHILD, INSTANCE);
		useOutlineStore.getState().zoom(CHILD);
		expect(useOutlineStore.getState().zoomedInstance).toBeNull();
	});
});
