import {createContext, startTransition, useCallback, useEffect, useRef, useState} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../../node-types.js";
import {nodeKeys} from "../node-cache.js";
import type {SearchFilter} from "../search-filter.js";
import type {RowLimits} from "../render-window.js";
import
{
	firstPaintRowBudget,
	initialRowBudget,
	nextRowBudget,
	printRowBudget,
	rowBudgetToShow,
	rowLimits,
	rowLimitsKey,
} from "../render-window.js";
import {afterNextPaint} from "../after-paint.js";
import {poppedScrollY} from "../scroll-restoration.js";
import {useOutlineStore} from "../stores/outline.js";
import {usePrinting} from "./use-printing.js";
import {usePaneExpandedIds} from "../components/pane-context.js";

/** The outline's per-parent row limits; null outside an `OutlineTree`, where `.children` render every row. */
export const RowLimitsContext = createContext<RowLimits | null>(null);

/** Every children query's hash starts so (TanStack hashes a key as its JSON). */
const CHILDREN_HASH_PREFIX = JSON.stringify(nodeKeys.children(null)).replace(/null\]$/u, "");

function viewportHeight(): number
{
	return typeof window === "undefined" ? 0 : window.innerHeight;
}

/**
 * The row limits for the outline under `rootId`, recomputed as children load or change, plus the current budget and
 * a callback raising it by one step. The budget restarts at a viewport of rows on each zoom and each search result,
 * and takes its step of slack below the fold after that view paints, as a transition that yields to input.
 * The limits keep their identity until some limit changes, so a cache write that moves no limit re-renders nothing.
 * Editing a row past the budget (an arrow key off the last rendered row) grows it to that row, in the same render.
 */
export function useRowLimits(
	rootId: string | null,
	search: SearchFilter | null,
):
{
	rowLimits: RowLimits;
	budgetRows: number;
	growBudget: () => void;
}
{
	const queryClient = useQueryClient();
	const expandedIds = usePaneExpandedIds();
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const animatingCompletionIds = useOutlineStore((state) => state.animatingCompletionIds);
	const result = search?.result;
	const printing = usePrinting();

	// A view Back/Forward restores scrolled down mounts rows down to that scroll, so it lands on rows.
	const firstRows = () => firstPaintRowBudget(viewportHeight() + poppedScrollY(rootId));
	const [budget, setBudget] = useState(() => (
	{
		rootId,
		result,
		rows: firstRows(),
	}));
	if (budget.rootId !== rootId || budget.result !== result)
	{
		setBudget(
			{
				rootId,
				result,
				rows: firstRows(),
			},
		);
	}
	useEffect(() =>
	{
		const run =
		{
			cancelled: false,
		};
		void (async () =>
		{
			await afterNextPaint();
			if (run.cancelled)
			{
				return;
			}
			startTransition(() =>
			{
				setBudget((current) =>
				{
					const rows = initialRowBudget(viewportHeight());
					return current.rootId === rootId && current.result === result && current.rows < rows
						?
							{
								...current,
								rows,
							}
						: current;
				});
			});
		})();
		return () =>
		{
			run.cancelled = true;
		};
	}, [rootId, result]);

	const getChildren = (parentId: string | null) =>
		queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId));
	const view =
	{
		expandedIds,
		showCompleted,
		animatingCompletionIds,
		search,
	};
	const compute = (): RowLimits => rowLimits(getChildren, rootId, printRowBudget(budget.rows, printing), view);
	const budgetToShow = (targetId: string): number =>
		rowBudgetToShow(getChildren, rootId, budget.rows, view, targetId);
	const computed = compute();
	const [stable, setStable] = useState(computed);
	if (rowLimitsKey(stable) !== rowLimitsKey(computed))
	{
		setStable(computed);
	}

	const latestCompute = useRef(compute);
	const latestBudgetToShow = useRef(budgetToShow);
	useEffect(() =>
	{
		latestCompute.current = compute;
		latestBudgetToShow.current = budgetToShow;
	});
	useEffect(
		() =>
			useOutlineStore.subscribe(({editingId}, previous) =>
			{
				if (editingId === null || editingId === previous.editingId)
				{
					return;
				}
				const rows = latestBudgetToShow.current(editingId);
				setBudget((current) =>
					rows > current.rows
						?
							{
								...current,
								rows,
							}
						: current,
				);
			}),
		[],
	);
	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) =>
			{
				if (event.type !== "updated" || !event.query.queryHash.startsWith(CHILDREN_HASH_PREFIX))
				{
					return;
				}
				const next = latestCompute.current();
				setStable((current) => (rowLimitsKey(current) === rowLimitsKey(next) ? current : next));
			}),
		[queryClient],
	);

	const growBudget = useCallback(() =>
	{
		setBudget((current) => (
		{
			...current,
			rows: nextRowBudget(current.rows),
		}));
	}, []);
	return {
		rowLimits: stable,
		budgetRows: budget.rows,
		growBudget,
	};
}
