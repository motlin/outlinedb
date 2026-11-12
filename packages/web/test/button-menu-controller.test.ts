import {describe, expect, it} from "vite-plus/test";
import {createButtonMenuController} from "../src/client/components/flyout/button-menu-controller.js";
import type {ButtonMenuControllerOptions} from "../src/client/components/flyout/button-menu-controller.js";

interface Timer
{
	id: number;
	at: number;
	fn: () => void;
}

function createHarness(options: Partial<ButtonMenuControllerOptions> = {})
{
	let now = 0;
	let nextId = 1;
	let timers: Timer[] = [];
	const bodyClasses = new Set<string>();
	const calls =
	{
		onShow: 0,
		onHide: 0,
		focusTrigger: 0,
	};
	const controller = createButtonMenuController(
		{
			forId: "breadcrumbs",
			setTimeout: (fn, ms) =>
			{
				const id = nextId++;
				timers.push(
					{
						id,
						at: now + ms,
						fn,
					},
				);
				return id;
			},
			clearTimeout: (id) =>
			{
				timers = timers.filter((timer) => timer.id !== id);
			},
			bodyClassList:
			{
				add: (name) =>
				{
					bodyClasses.add(name);
				},
				remove: (name) =>
				{
					bodyClasses.delete(name);
				},
			},
			onShow: () =>
			{
				calls.onShow++;
			},
			onHide: () =>
			{
				calls.onHide++;
			},
			focusTrigger: () =>
			{
				calls.focusTrigger++;
			},
			...options,
		},
	);
	return {
		controller,
		calls,
		advance(ms: number)
		{
			const target = now + ms;
			for (;;)
			{
				let due: Timer | undefined;
				for (const timer of timers)
				{
					if (timer.at <= target && (due === undefined || timer.at < due.at))
					{
						due = timer;
					}
				}
				if (due === undefined)
				{
					break;
				}
				const fired = due;
				timers = timers.filter((timer) => timer !== fired);
				now = fired.at;
				fired.fn();
			}
			now = target;
		},
		state()
		{
			return {
				open: controller.isOpen(),
				bodyClasses: [...bodyClasses],
				onShowCalls: calls.onShow,
				onHideCalls: calls.onHide,
			};
		},
	};
}

describe("createButtonMenuController", () =>
{
	it("starts closed", () =>
	{
		const h = createHarness();
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 0,
				onHideCalls: 0,
			},
		);
	});

	it("opens on focus, ignores a click inside the 300ms guard, then asks to blur", () =>
	{
		const h = createHarness();
		h.controller.focus();
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		h.advance(100);
		expect(h.controller.click(true)).toBe("none");
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		h.advance(300);
		expect(h.controller.click(true)).toBe("blur");
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		h.controller.blur();
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 1,
				onHideCalls: 1,
			},
		);
	});

	it("hides on a post-guard click when the active element is outside the trigger or missing", () =>
	{
		for (const active of [false, null])
		{
			const h = createHarness();
			h.controller.focus();
			h.advance(400);
			expect(h.controller.click(active)).toBe("hide");
			expect(h.state()).toStrictEqual(
				{
					open: false,
					bodyClasses: [],
					onShowCalls: 1,
					onHideCalls: 1,
				},
			);
		}
	});

	it("ignores a click bubbling up from the flyout, so an item that closed the menu does not reopen it", () =>
	{
		const h = createHarness();
		h.controller.focus();
		h.advance(400);
		// The item's handler blurs the trigger (Complete), then its click bubbles through the React portal.
		h.controller.blur();
		expect(
			{
				action: h.controller.click(null, true),
				state: h.state(),
			},
		).toStrictEqual(
			{
				action: "none",
				state:
				{
					open: false,
					bodyClasses: [],
					onShowCalls: 1,
					onHideCalls: 1,
				},
			},
		);
	});

	it("opens on click when closed", () =>
	{
		const h = createHarness();
		expect(h.controller.click(null)).toBe("open");
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
	});

	it("does not add a body class without forId", () =>
	{
		const h = createHarness(
			{
				forId: undefined,
			},
		);
		h.controller.focus();
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: [],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
	});

	it("actOnHover: enter opens, leave hides after exactly 100ms", () =>
	{
		const h = createHarness(
			{
				actOnHover: true,
			},
		);
		h.controller.mouseEnter();
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		h.controller.mouseLeave();
		h.advance(99);
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		h.advance(1);
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 1,
				onHideCalls: 1,
			},
		);
	});

	it("actOnHover: re-entering within 100ms cancels the pending hide", () =>
	{
		const h = createHarness(
			{
				actOnHover: true,
			},
		);
		h.controller.mouseEnter();
		h.controller.mouseLeave();
		h.advance(50);
		h.controller.mouseEnter();
		h.advance(500);
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 2,
				onHideCalls: 0,
			},
		);
	});

	it("actOnHover: clicks are ignored whether open or closed", () =>
	{
		const h = createHarness(
			{
				actOnHover: true,
			},
		);
		expect(h.controller.click(true)).toBe("none");
		h.controller.mouseEnter();
		h.advance(400);
		expect(h.controller.click(true)).toBe("none");
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
	});

	it("hover handlers do nothing without actOnHover", () =>
	{
		const h = createHarness();
		h.controller.mouseEnter();
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 0,
				onHideCalls: 0,
			},
		);
		h.controller.focus();
		h.controller.mouseLeave();
		h.advance(500);
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
	});

	it("blockCloseOnInternalClick: pointer down in the flyout keeps it open and refocuses the trigger once", () =>
	{
		const h = createHarness(
			{
				blockCloseOnInternalClick: true,
			},
		);
		h.controller.focus();
		h.controller.flyoutPointerDown();
		h.controller.blur();
		expect(h.state()).toStrictEqual(
			{
				open: true,
				bodyClasses: ["button-menu-for-breadcrumbs"],
				onShowCalls: 1,
				onHideCalls: 0,
			},
		);
		expect(h.calls.focusTrigger).toBe(1);
		h.controller.blur();
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 1,
				onHideCalls: 1,
			},
		);
		expect(h.calls.focusTrigger).toBe(1);
	});

	it("without blockCloseOnInternalClick a flyout pointer down does not block blur", () =>
	{
		const h = createHarness();
		h.controller.focus();
		h.controller.flyoutPointerDown();
		h.controller.blur();
		expect(h.state()).toStrictEqual(
			{
				open: false,
				bodyClasses: [],
				onShowCalls: 1,
				onHideCalls: 1,
			},
		);
		expect(h.calls.focusTrigger).toBe(0);
	});

	it("exposes no escape transition: upstream ButtonMenu leaves Escape to the global search handler", () =>
	{
		const h = createHarness();
		expect(Object.keys(h.controller)).toStrictEqual([
			"focus",
			"blur",
			"mouseEnter",
			"mouseLeave",
			"flyoutPointerDown",
			"click",
			"isOpen",
		]);
	});
});
