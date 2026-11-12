// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useRowLimits} from "../src/client/hooks/use-row-limits.js";
import {firstPaintRowBudget, initialRowBudget} from "../src/client/render-window.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function treeRow(index: number): NodeResponse
{
	return {
		id: `row-${index}`,
		parent_id: null,
		name: `row ${index}`,
		note: null,
		priority: index,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

let root: Root | undefined;

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

describe("useRowLimits", () =>
{
	it("mounts a viewport of rows with the swap and adds the step below the fold after the paint", async () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			nodeKeys.children(null),
			Array.from(
				{
					length: 300,
				},
				(_, index) => treeRow(index),
			),
		);
		const budgets: number[] = [];
		function Probe()
		{
			budgets.push(useRowLimits(null, null).budgetRows);
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
					createElement(Probe),
				),
			);
		});
		const atSwap = budgets.at(-1);
		await act(async () =>
		{
			await new Promise((resolve) =>
			{
				requestAnimationFrame(() =>
				{
					setTimeout(resolve, 10);
				});
			});
		});
		expect(
			{
				atSwap,
				afterPaint: budgets.at(-1),
			},
		).toStrictEqual(
			{
				atSwap: firstPaintRowBudget(globalThis.innerHeight),
				afterPaint: initialRowBudget(globalThis.innerHeight),
			},
		);
	});

	it("grows the row budget when the caret moves onto a row past the last one rendered", () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			nodeKeys.children(null),
			Array.from(
				{
					length: 300,
				},
				(_, index) => treeRow(index),
			),
		);
		let budgets: number[] = [];
		function Probe()
		{
			budgets.push(useRowLimits(null, null).budgetRows);
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
					createElement(Probe),
				),
			);
		});
		const initial = budgets.at(-1) ?? 0;
		budgets = [];
		act(() =>
		{
			useOutlineStore.setState(
				{
					editingId: `row-${initial - 1}`,
				},
			);
		});
		const inside = budgets.at(-1) ?? initial;
		act(() =>
		{
			useOutlineStore.setState(
				{
					editingId: `row-${initial}`,
				},
			);
		});
		expect(
			{
				inside: inside - initial,
				past: (budgets.at(-1) ?? 0) - initial,
			},
		).toStrictEqual(
			{
				inside: 0,
				past: 24,
			},
		);
	});
});
