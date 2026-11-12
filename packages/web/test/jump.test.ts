// @vitest-environment happy-dom
import {renders} from "./helpers/render-counter.js"; // Before react-dom, which looks for the DevTools hook it installs when it loads.
import {afterEach, beforeEach, describe, expect, it, vi, afterAll, beforeAll} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {SwitcherRow} from "../src/client/switcher-rows.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {JumpMenu, SwitcherDialog} from "../src/client/components/jump-menu.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import type {SwitcherResult} from "../src/server/switcher-search.js";
import {emitSwitcherStep} from "../src/client/switcher-keys.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("jump menu open in pane", () => {
	function row(id: string, query: string | null = null): SwitcherRow {
		return {
			key: id,
			id,
			nodeId: id,
			query,
			search: null,
			labelHtml: id,
			completed: false,
			starred: false,
			ancestors: [],
		};
	}

	const noop = () => {};
	let root: Root | undefined;
	let container: HTMLElement;

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function renderDialog(props: {
		query?: string;
		selectedIndex: number;
		onSelect?: (row: SwitcherRow) => void;
		onOpenInPane?: (row: SwitcherRow) => void;
	}) {
		act(() => {
			root?.render(
				createElement(SwitcherDialog, {
					query: props.query ?? "",
					rows: [row("alice"), row("bob")],
					selectedIndex: props.selectedIndex,
					emptyText: null,
					indexing: false,
					onQueryChange: noop,
					onKeyDown: noop,
					onSelect: props.onSelect ?? noop,
					onOpenInPane: props.onOpenInPane ?? noop,
					onHover: noop,
					onClose: noop,
					onScrollNearEnd: noop,
				}),
			);
		});
	}

	describe("jump menu Open in pane chip", () => {
		it("renders upstream's action box on the selected row only", () => {
			renderDialog({selectedIndex: 1});
			const boxes = [...document.querySelectorAll(".switcher-option")].map(
				(option) => option.querySelector(".shrink-0")?.outerHTML.replace(/<svg.*<\/svg>/u, "<svg/>") ?? null,
			);
			expect(boxes).toStrictEqual([
				null,
				'<div class="flex items-center gap-xs shrink-0"><button tabindex="0" class="!px-xs !py-xs !text-xs !rounded-pill button secondary"><span class=""><div class="flex flex-row items-center !gap-xs"><svg/></div></span></button></div>',
			]);
		});

		it("uses the table-columns icon", () => {
			renderDialog({selectedIndex: 0});
			expect(document.querySelector(".switcher-option .shrink-0 svg")?.getAttribute("data-icon")).toBe(
				"table-columns",
			);
		});

		it("renders no box while the filter is .. or -", () => {
			renderDialog({selectedIndex: 0, query: ".."});
			renderDialog({selectedIndex: 0, query: "-"});
			expect(document.querySelectorAll(".switcher-option .shrink-0")).toHaveLength(0);
		});

		it("clicking the chip opens in a pane and never selects the row", () => {
			const onSelect = vi.fn<(row: SwitcherRow) => void>();
			const onOpenInPane = vi.fn<(row: SwitcherRow) => void>();
			renderDialog({selectedIndex: 0, onSelect, onOpenInPane});
			act(() => {
				document.querySelector<HTMLButtonElement>(".switcher-option .shrink-0 button")?.click();
			});
			expect({select: onSelect.mock.calls, open: onOpenInPane.mock.calls}).toStrictEqual({
				select: [],
				open: [[row("alice")]],
			});
		});

		it("makes the chip a tab stop right after the input", () => {
			renderDialog({selectedIndex: 0});
			const focusable = [...document.querySelectorAll<HTMLElement>("input, button, [tabindex]")];
			expect(focusable.map((element) => element.tagName)).toStrictEqual(["INPUT", "BUTTON"]);
			expect(focusable[1]?.tabIndex).toBe(0);
		});
	});

	describe("JumpMenu Open in pane", () => {
		function mountMenu(results: unknown[]) {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async (request) => {
					const url =
						typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
					return Promise.resolve(
						url.includes("/api/search/switcher")
							? Response.json({results, hasMore: false})
							: Response.json({}, {status: 404}),
					);
				}),
			);
			act(() => {
				root?.render(
					createElement(
						QueryClientProvider,
						{client: new QueryClient({defaultOptions: {queries: {retry: false}}})},
						createElement(MemoryRouter, null, createElement(JumpMenu)),
					),
				);
			});
		}

		async function typeQuery(value: string) {
			await act(async () => {
				const input = document.querySelector("input");
				if (input === null) {
					throw new TypeError("no switcher input");
				}
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
				input.dispatchEvent(new Event("input", {bubbles: true}));
				await new Promise((resolve) => {
					setTimeout(resolve, 50);
				});
			});
		}

		it("closes the menu and opens the row in a new focused pane", async () => {
			useOutlineStore.setState({jumpMenuOpen: true, panes: [], activePaneId: "main"});
			mountMenu([{id: "alice-0", labelHtml: "Alice", completed: false, starred: false, ancestors: []}]);
			await typeQuery("al");
			act(() => {
				document.querySelector<HTMLButtonElement>(".switcher-option .shrink-0 button")?.click();
			});
			const state = useOutlineStore.getState();
			expect({
				open: state.jumpMenuOpen,
				panes: state.panes.map((pane) => ({zoomedId: pane.zoomedId, query: pane.query})),
				active: state.activePaneId === state.panes[0]?.id,
			}).toStrictEqual({open: false, panes: [{zoomedId: "alice-0", query: ""}], active: true});
		});
	});
});

describe("jump menu renders", () => {
	/** Twenty matches, answered as fresh JSON for every query like the server does. */
	const results: SwitcherResult[] = Array.from({length: 20}, (_, index) => ({
		id: `alice-${index}`,
		labelHtml: `Alice ${index}`,
		completed: false,
		starred: false,
		ancestors: [{id: "bob", name: "Bob"}],
	}));

	const queryClient = new QueryClient({
		defaultOptions: {queries: {retry: false, staleTime: Number.POSITIVE_INFINITY}},
	});
	let root: Root | undefined;

	async function settle(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 250);
			});
		});
	}

	function input(): HTMLInputElement {
		const element = document.querySelector("input");
		if (!(element instanceof HTMLInputElement)) {
			throw new TypeError("no switcher input");
		}
		return element;
	}

	function type(value: string): void {
		act(() => {
			const element = input();
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
			element.dispatchEvent(new Event("input", {bubbles: true}));
		});
	}

	beforeAll(async () => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (request) => {
				const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
				return Promise.resolve(
					url.includes("/api/search/switcher")
						? Response.json({results, hasMore: false})
						: Response.json({}, {status: 404}),
				);
			}),
		);
		useOutlineStore.setState({jumpMenuOpen: true});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: queryClient},
					createElement(MemoryRouter, null, createElement(JumpMenu)),
				),
			);
		});
		type("a");
		await settle();
	});

	afterAll(() => {
		act(() => {
			root?.unmount();
		});
		vi.unstubAllGlobals();
	});

	describe("JumpMenu render count", () => {
		it("lists the server's matches", () => {
			expect(document.querySelectorAll(".switcher-option")).toHaveLength(20);
		});

		it("does not re-render unchanged options when a keystroke brings back the same matches", async () => {
			renders.clear();
			type("al");
			await settle();
			expect(renders.get("SwitcherOption") ?? 0).toBe(0);
		});

		it("scrolls a newly selected row into view with block nearest", async () => {
			const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
			const original: unknown = Reflect.get(Element.prototype, "scrollIntoView");
			Element.prototype.scrollIntoView = function scroll(this: Element, options?: ScrollIntoViewOptions) {
				scrollIntoView.call(this, options);
			};
			try {
				act(() => {
					emitSwitcherStep("next");
				});
				await settle();
				expect(scrollIntoView.mock.calls).toStrictEqual([[{block: "nearest"}]]);
				expect(scrollIntoView.mock.contexts).toStrictEqual([document.querySelectorAll(".switcher-option")[1]]);
			} finally {
				Reflect.set(Element.prototype, "scrollIntoView", original);
			}
		});

		it("re-renders only the two options the selection moves between", async () => {
			renders.clear();
			act(() => {
				emitSwitcherStep("next");
			});
			await settle();
			expect(renders.get("SwitcherOption") ?? 0).toBe(2);
		});

		it("does not re-render the options below a row that drops out of the list", () => {
			const rows = results.map((result) => ({
				...result,
				key: result.id,
				nodeId: result.id,
				query: null,
				search: null,
			}));
			const noop = () => {};
			const dialog = (shown: typeof rows) =>
				createElement(SwitcherDialog, {
					query: "",
					rows: shown,
					selectedIndex: 0,
					emptyText: null,
					indexing: false,
					onQueryChange: noop,
					onKeyDown: noop,
					onSelect: noop,
					onOpenInPane: noop,
					onHover: noop,
					onClose: noop,
					onScrollNearEnd: noop,
				});
			const dialogRoot = createRoot(document.createElement("div"));
			act(() => {
				dialogRoot.render(dialog(rows));
			});
			renders.clear();
			act(() => {
				dialogRoot.render(dialog(rows.slice(1).map((row) => ({...row}))));
			});
			act(() => {
				dialogRoot.unmount();
			});
			// Only the new first row, which takes the selection.
			expect(renders.get("SwitcherOption") ?? 0).toBe(1);
		});
	});
});
