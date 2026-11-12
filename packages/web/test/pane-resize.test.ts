// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {bindPaneSeparator, handleSeparatorKey} from "../src/client/pane-resize.js";

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
