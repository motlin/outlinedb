// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {paneFocusTarget, requestPaneFocus} from "../src/client/pane-focus.js";
import {bindPaneSeparator, handleSeparatorKey} from "../src/client/pane-resize.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {PaneSearchBox} from "../src/client/components/pane-search-box.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("pane focus", () =>
{
	function pane(id: string, html: string): HTMLElement
	{
		const element = document.createElement("div");
		element.dataset.paneId = id;
		element.innerHTML = html;
		document.body.append(element);
		return element;
	}

	const zoomed =
		'<div class="project root"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="T">T</span></div></div></div><div class="project"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="C">child</span></div></div></div>';
	const home =
		'<div class="project"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="R1">first</span></div></div></div>';

	afterEach(() =>
	{
		document.body.innerHTML = "";
		vi.unstubAllGlobals();
	});

	describe("paneFocusTarget", () =>
	{
		it("is the zoom title's content when zoomed", () =>
		{
			const root = pane("p", zoomed);
			expect(paneFocusTarget(root)?.querySelector("[data-node-id]")?.getAttribute("data-node-id")).toBe("T");
		});

		it("is the first row's content at Home", () =>
		{
			const root = pane("p", home);
			expect(paneFocusTarget(root)?.querySelector("[data-node-id]")?.getAttribute("data-node-id")).toBe("R1");
		});

		it("is null for a pane with no rows", () =>
		{
			expect(paneFocusTarget(pane("p", ""))).toBeNull();
		});
	});

	describe("requestPaneFocus", () =>
	{
		let frames: (() => void)[];
		const runFrame = () =>
		{
			const pending = frames;
			frames = [];
			for (const frame of pending)
			{
				frame();
			}
		};
		beforeEach(() =>
		{
			frames = [];
			vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
		});

		it("puts the caret on the pane's title at offset 0 and reveals the pane on the next frame", () =>
		{
			const root = pane("p", zoomed);
			const reveal = vi.fn<(options: ScrollIntoViewOptions) => void>();
			root.scrollIntoView = reveal;
			const resume = vi.fn<(nodeId: string, offset: number) => void>();
			requestPaneFocus(
				{
					paneId: "p",
					zoomedId: "T",
					reveal: true,
				},
				{
					resumeEditing: resume,
				},
			);
			expect(resume).not.toHaveBeenCalled();
			runFrame();
			expect(
				{
					resume: resume.mock.calls,
					reveal: reveal.mock.calls,
				},
			).toStrictEqual(
				{
					resume: [["T", 0]],
					reveal: [
						[
							{
								block: "nearest",
								inline: "nearest",
							},
						],
					],
				},
			);
		});

		it("does not reveal the pane after a close", () =>
		{
			const root = pane("p", zoomed);
			const reveal = vi.fn<(options: ScrollIntoViewOptions) => void>();
			root.scrollIntoView = reveal;
			requestPaneFocus(
				{
					paneId: "p",
					zoomedId: "T",
					reveal: false,
				},
				{
					resumeEditing: vi.fn<(nodeId: string, offset: number) => void>(),
				},
			);
			runFrame();
			expect(reveal).not.toHaveBeenCalled();
		});

		it("waits for the pane to render the requested zoom", () =>
		{
			const root = pane("p", home);
			const resume = vi.fn<(nodeId: string, offset: number) => void>();
			requestPaneFocus(
				{
					paneId: "p",
					zoomedId: "T",
					reveal: true,
				},
				{
					resumeEditing: resume,
				},
			);
			runFrame();
			expect(resume).not.toHaveBeenCalled();
			root.innerHTML = zoomed;
			runFrame();
			expect(resume.mock.calls).toStrictEqual([["T", 0]]);
		});

		it("gives up after 60 frames when the pane never appears", () =>
		{
			const resume = vi.fn<(nodeId: string, offset: number) => void>();
			requestPaneFocus(
				{
					paneId: "missing",
					zoomedId: null,
					reveal: true,
				},
				{
					resumeEditing: resume,
				},
			);
			for (let frame = 0; frame < 80; frame++)
			{
				runFrame();
			}
			expect(
				{
					resume: resume.mock.calls,
					pending: frames.length,
				},
			).toStrictEqual(
				{
					resume: [],
					pending: 0,
				},
			);
		});

		it("lets a newer request cancel a pending one", () =>
		{
			pane("a", home);
			pane("b", zoomed);
			const resume = vi.fn<(nodeId: string, offset: number) => void>();
			requestPaneFocus(
				{
					paneId: "a",
					zoomedId: null,
					reveal: true,
				},
				{
					resumeEditing: resume,
				},
			);
			requestPaneFocus(
				{
					paneId: "b",
					zoomedId: "T",
					reveal: true,
				},
				{
					resumeEditing: resume,
				},
			);
			runFrame();
			expect(resume.mock.calls).toStrictEqual([["T", 0]]);
		});
	});
});

describe("pane resize", () =>
{
	const AVAILABLE = 1416;

	function pointerEvent(
		type: string,
		init:
		{
			clientX?: number;
			button?: number;
			isPrimary?: boolean;
		} = {},
	): Event
	{
		const event = new Event(
			type,
			{
				bubbles: true,
				cancelable: true,
			},
		);
		return Object.assign(
			event,
			{
				pointerId: 7,
				isPrimary: true,
				button: 0,
				clientX: 0,
				...init,
			},
		);
	}

	let frames: (() => void)[] = [];

	beforeEach(() =>
	{
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
		vi.stubGlobal("cancelAnimationFrame", () => {});
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	function setup(initial: number[])
	{
		const scroller = document.createElement("div");
		const separator = document.createElement("div");
		document.body.append(scroller, separator);
		scroller.getBoundingClientRect = () =>
			(
			{
				left: 0,
				right: AVAILABLE,
				top: 0,
				bottom: 800,
			}) as DOMRect;
		const state =
		{
			widths: [...initial],
			resizing: [] as boolean[],
			resizeEvents: 0,
		};
		separator.setPointerCapture = () =>
		{
		};
		separator.releasePointerCapture = () =>
		{
		};
		const onResize = () =>
		{
			state.resizeEvents += 1;
		};
		globalThis.addEventListener("resize", onResize);
		const unbind = bindPaneSeparator(
			separator,
			0,
			{
				scroller,
				getWidths: () => state.widths,
				available: () => AVAILABLE,
				setWidths: (widths) =>
				{
					state.widths = widths;
				},
				setResizing: (resizing) =>
				{
					state.resizing.push(resizing);
				},
			},
		);
		return {
			scroller,
			separator,
			state,
			stop: () =>
			{
				unbind();
				globalThis.removeEventListener("resize", onResize);
				scroller.remove();
				separator.remove();
			},
		};
	}

	describe("bindPaneSeparator", () =>
	{
		it("drags the divider, then Escape restores the start widths without focusing anything else", () =>
		{
			const {separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: 450,
					},
				),
			);
			const afterFirst = [...state.widths];
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: 390,
					},
				),
			);
			const afterBack = [...state.widths];
			const escape = new KeyboardEvent(
				"keydown",
				{
					key: "Escape",
					cancelable: true,
					bubbles: true,
				},
			);
			document.dispatchEvent(escape);
			stop();
			expect(
				{
					afterFirst,
					afterBack,
					restored: state.widths,
					escapePrevented: escape.defaultPrevented,
					resizing: state.resizing,
					resizeEvents: state.resizeEvents,
				},
			).toStrictEqual(
				{
					afterFirst: [450, 1066],
					afterBack: [390, 1066],
					restored: [350, 1066],
					escapePrevented: true,
					resizing: [true, false],
					resizeEvents: 0,
				},
			);
		});

		it("commits on pointerup with exactly one window resize event", () =>
		{
			const {separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointerup",
					{
						clientX: 400,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointerup",
					{
						clientX: 900,
					},
				),
			);
			stop();
			expect(
				{
					widths: state.widths,
					resizing: state.resizing,
					resizeEvents: state.resizeEvents,
				},
			).toStrictEqual(
				{
					widths: [400, 1066],
					resizing: [true, false],
					resizeEvents: 1,
				},
			);
		});

		it("scrolls the workspace each frame near its right edge, faster the closer the pointer is", () =>
		{
			const {scroller, separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: AVAILABLE - 30,
					},
				),
			);
			frames.shift()?.();
			const nearScroll = scroller.scrollLeft;
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: AVAILABLE - 2,
					},
				),
			);
			frames.shift()?.();
			const closerScroll = scroller.scrollLeft - nearScroll;
			stop();
			expect(
				{
					nearScroll,
					closerScroll: Number(closerScroll.toFixed(1)),
					resizing: state.resizing,
				},
			).toStrictEqual(
				{
					nearScroll: 6,
					closerScroll: 11.6,
					resizing: [true, false],
				},
			);
		});

		it("restores widths, scroll position and scroll behavior on pointercancel", () =>
		{
			const {scroller, separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
					},
				),
			);
			const during = scroller.style.scrollBehavior;
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: 500,
					},
				),
			);
			document.dispatchEvent(pointerEvent("pointercancel"));
			stop();
			expect(
				{
					during,
					after: scroller.style.scrollBehavior,
					widths: state.widths,
					scrollLeft: scroller.scrollLeft,
				},
			).toStrictEqual(
				{
					during: "auto",
					after: "",
					widths: [350, 1066],
					scrollLeft: 0,
				},
			);
		});

		it("ignores a non-primary-button press", () =>
		{
			const {separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
						button: 2,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: 500,
					},
				),
			);
			stop();
			expect(
				{
					widths: state.widths,
					resizing: state.resizing,
				},
			).toStrictEqual(
				{
					widths: [350, 1066],
					resizing: [],
				},
			);
		});

		it("cancels a drag when unbound", () =>
		{
			const {separator, state, stop} = setup([350, 1066]);
			separator.dispatchEvent(
				pointerEvent(
					"pointerdown",
					{
						clientX: 350,
					},
				),
			);
			document.dispatchEvent(
				pointerEvent(
					"pointermove",
					{
						clientX: 500,
					},
				),
			);
			stop();
			expect(
				{
					widths: state.widths,
					resizing: state.resizing,
				},
			).toStrictEqual(
				{
					widths: [350, 1066],
					resizing: [true, false],
				},
			);
		});
	});

	describe("handleSeparatorKey", () =>
	{
		function press(widths: number[], index: number, key: string, shiftKey = false)
		{
			const state =
			{
				widths,
				prevented: false,
				stopped: false,
				scrolled: 0,
				resizeEvents: 0,
			};
			const onResize = () =>
			{
				state.resizeEvents += 1;
			};
			globalThis.addEventListener("resize", onResize);
			handleSeparatorKey(
				{
					key,
					shiftKey,
					preventDefault: () =>
					{
						state.prevented = true;
					},
					stopPropagation: () =>
					{
						state.stopped = true;
					},
					currentTarget:
					{
						scrollIntoView: () =>
						{
							state.scrolled += 1;
						},
					},
				},
				index,
				{
					getWidths: () => state.widths,
					available: () => AVAILABLE,
					setWidths: (next) =>
					{
						state.widths = next;
					},
				},
			);
			frames.shift()?.();
			globalThis.removeEventListener("resize", onResize);
			return state;
		}

		it("resizes by 10px, 50px with Shift, or to the minimum with Home, like upstream", () =>
		{
			const left = press([716, 716], 0, "ArrowLeft");
			const shiftLeft = press(left.widths, 0, "ArrowLeft", true);
			const shiftRight = press(shiftLeft.widths, 0, "ArrowRight", true);
			const home = press(shiftRight.widths, 0, "Home");
			expect(
				{
					left: left.widths,
					shiftLeft: shiftLeft.widths,
					shiftRight: shiftRight.widths,
					home: home.widths,
					handled: [left, home].map((s) => [s.prevented, s.stopped, s.scrolled, s.resizeEvents]),
				},
			).toStrictEqual(
				{
					left: [706, 716],
					shiftLeft: [656, 760],
					shiftRight: [706, 760],
					home: [350, 1066],
					handled: [
						[true, true, 1, 1],
						[true, true, 1, 1],
					],
				},
			);
		});

		it("leaves every other key alone", () =>
		{
			const end = press([716, 716], 0, "End");
			expect(
				{
					widths: end.widths,
					prevented: end.prevented,
					stopped: end.stopped,
				},
			).toStrictEqual(
				{
					widths: [716, 716],
					prevented: false,
					stopped: false,
				},
			);
		});
	});
});

describe("pane search box", () =>
{
	let root: Root | undefined;
	let container: HTMLDivElement;
	let commits: string[] = [];

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		commits = [];
		container = document.createElement("div");
		document.body.append(container);
	});

	afterEach(() =>
	{
		act(() =>
		{
			root?.unmount();
		});
		root = undefined;
		container.remove();
	});

	function mount(query: string): void
	{
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					PaneSearchBox,
					{
						query,
						compact: true,
						onCommit: (value: string) =>
						{
							commits.push(value);
						},
					},
				),
			);
		});
	}

	function input(): HTMLInputElement
	{
		const element = container.querySelector("input");
		if (element === null)
		{
			throw new Error("no search input");
		}
		return element;
	}

	function label(): HTMLLabelElement
	{
		const element = container.querySelector("label.searchBox");
		if (!(element instanceof HTMLLabelElement))
		{
			throw new TypeError("no search label");
		}
		return element;
	}

	function type(value: string): void
	{
		act(() =>
		{
			const element = input();
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
			input().dispatchEvent(
				new Event(
					"input",
					{
						bubbles: true,
					},
				),
			);
		});
	}

	function press(key: string): void
	{
		act(() =>
		{
			input().dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key,
						bubbles: true,
					},
				),
			);
		});
	}

	describe("PaneSearchBox", () =>
	{
		it("is upstream's compact 36px search circle while empty and unfocused", () =>
		{
			mount("");
			expect(
				{
					width: label().style.width,
					height: label().style.height,
					placeholder: input().placeholder,
					hidden: input().classList.contains("opacity-0"),
				},
			).toStrictEqual(
				{
					width: "36px",
					height: "36px",
					placeholder: "Search",
					hidden: true,
				},
			);
		});

		it("uses upstream's collapsed class order", () =>
		{
			mount("");
			expect(label().className).toBe(
				"relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base hover:!bg-tertiary searchBox",
			);
		});

		it("opens into a pill on focus", () =>
		{
			mount("");
			const before = label();
			act(() =>
			{
				input().focus();
			});
			expect(
				{
					width: label().style.width,
					hidden: input().classList.contains("opacity-0"),
					sameLabel: label() === before,
					focused: document.activeElement === input(),
				},
			).toStrictEqual(
				{
					width: "210px",
					hidden: false,
					sameLabel: true,
					focused: true,
				},
			);
		});

		it("commits the typed query on Enter", () =>
		{
			mount("");
			act(() =>
			{
				input().focus();
			});
			type("#todo");
			press("Enter");
			expect(commits).toStrictEqual(["#todo"]);
		});

		it("shows the pane's committed query as an open pill", () =>
		{
			mount("#todo");
			expect(
				{
					value: input().value,
					width: label().style.width,
				},
			).toStrictEqual(
				{
					value: "#todo",
					width: "210px",
				},
			);
		});

		it("clears the pane search from its clear control", () =>
		{
			mount("#todo");
			act(() =>
			{
				container.querySelector("svg.cursor-pointer")?.dispatchEvent(
					new MouseEvent(
						"click",
						{
							bubbles: true,
						},
					),
				);
			});
			expect(
				{
					commits,
					value: input().value,
				},
			).toStrictEqual(
				{
					commits: [""],
					value: "",
				},
			);
		});

		it("clears the pane search and leaves the box on Escape", () =>
		{
			mount("#todo");
			act(() =>
			{
				input().focus();
			});
			press("Escape");
			expect(
				{
					commits,
					value: input().value,
					focused: document.activeElement === input(),
				},
			).toStrictEqual(
				{
					commits: [""],
					value: "",
					focused: false,
				},
			);
		});
	});
});
