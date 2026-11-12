// @vitest-environment happy-dom
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import type {ReactElement} from "react";
import {MemoryRouter, useNavigate} from "react-router-dom";
import type {NavigateFunction} from "react-router-dom";
import {useRowState} from "../src/client/hooks/use-row-state.js";
import {StableNavigateProvider, useStableNavigate} from "../src/client/hooks/use-stable-navigate.js";
import {useOutlineViewState} from "../src/client/hooks/use-outline-view-state.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;

/** Mounts a probe that calls `hook` and returns a reader for how many times it has rendered. */
function mountProbe(hook: () => unknown, wrap: (probe: ReactElement) => ReactElement = (probe) => probe): () => number
{
	let renders = 0;
	function Probe()
	{
		hook();
		renders++;
		return null;
	}
	const container = document.createElement("div");
	root = createRoot(container);
	act(() =>
	{
		root?.render(wrap(createElement(Probe)));
	});
	return () => renders;
}

function setStore(partial: Partial<ReturnType<typeof useOutlineStore.getState>>): void
{
	act(() =>
	{
		useOutlineStore.setState(partial);
	});
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
});

describe("useOutlineViewState", () =>
{
	it("does not re-render the whole page for store changes the page shell does not show", () =>
	{
		const renders = mountProbe(useOutlineViewState);
		setStore(
			{
				editingId: "alice",
			},
		);
		setStore(
			{
				expandedIds: new Set(["bob"]),
			},
		);
		setStore(
			{
				lastEditedId: "alice",
			},
		);
		expect(renders()).toBe(1);
	});

	it("does not re-render the whole page for a zoom or search, which the main outline lays out itself", () =>
	{
		const renders = mountProbe(useOutlineViewState);
		setStore(
			{
				zoomedNodeId: "alice",
			},
		);
		setStore(
			{
				searchQuery: "carol",
			},
		);
		expect(renders()).toBe(1);
	});

	it("does not re-render the whole page when the pinned left bar resizes, since panes size by their flex shares", () =>
	{
		const renders = mountProbe(useOutlineViewState);
		setStore(
			{
				leftBarMode: "alwaysOpen",
			},
		);
		setStore(
			{
				leftBarWidth: 300,
			},
		);
		expect(renders()).toBe(1);
	});
});

describe("useRowState", () =>
{
	it("re-renders a row only when editing enters or leaves it", () =>
	{
		const renders = mountProbe(() => useRowState("alice", "main"));
		setStore(
			{
				editingId: "bob",
			},
		);
		setStore(
			{
				editingId: "alice",
			},
		);
		setStore(
			{
				editingId: "carol",
			},
		);
		setStore(
			{
				editingId: "dave",
			},
		);
		expect(renders()).toBe(3);
	});
});

describe("store subscriptions", () =>
{
	it("never subscribes a component to the whole outline store", () =>
	{
		const clientDir = join(import.meta.dirname, "../src/client");
		const offenders = readdirSync(
			clientDir,
			{
				recursive: true,
				encoding: "utf8",
			},
		)
			.filter((file) => /\.tsx?$/u.test(file))
			.filter((file) => readFileSync(join(clientDir, file), "utf8").includes("useOutlineStore()"));
		expect(offenders).toStrictEqual([]);
	});
});

describe("useStableNavigate", () =>
{
	it("hands rows a navigate that survives URL changes without re-rendering them", () =>
	{
		let navigateFromProbe: NavigateFunction | undefined;
		let navigateFromRouter: NavigateFunction | undefined;
		function RouterNavigate({capture}: {capture: (navigate: NavigateFunction) => void})
		{
			capture(useNavigate());
			return null;
		}
		const renders = mountProbe(
			() =>
			{
				navigateFromProbe = useStableNavigate();
			},
			(probe) =>
				createElement(
					MemoryRouter,
					null,
					createElement(
						StableNavigateProvider,
						null,
						probe,
						createElement(
							RouterNavigate,
							{
								capture: (navigate) =>
								{
									navigateFromRouter = navigate;
								},
							},
						),
					),
				),
		);
		const first = navigateFromProbe;
		act(() =>
		{
			void navigateFromRouter?.("/#/alice");
		});
		act(() =>
		{
			void navigateFromProbe?.("/#/bob");
		});
		expect(
			{
				renders: renders(),
				stable: navigateFromProbe === first,
			},
		).toStrictEqual(
			{
				renders: 1,
				stable: true,
			},
		);
	});
});
