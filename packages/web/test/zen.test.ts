import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {ZEN, ZEN_CURRENT, ZEN_FOCUSED, createZenController, scrollCounts} from "../src/client/zen-mode.js";
import type {ZenDeps} from "../src/client/zen-mode.js";

describe("zen mode css", () =>
{
	const css = readFileSync(new URL("../src/client/zen-mode.css", import.meta.url), "utf8").replaceAll(/\s+/gu, " ");

	describe("zen-mode.css", () =>
	{
		it("hides the header but for a 6px strip and a hover zone", () =>
		{
			expect(css).toContain(
				"body.zen-mode .wf-header.header { opacity: 0; transform: translateY(calc(-100% + 6px)); }",
			);
			expect(css).toContain(
				'body.zen-mode .wf-header.header::before { content: ""; position: absolute; left: 0; right: 0; top: calc(100% - 6px); height: calc(var(--wf-header-height) - 6px); }',
			);
			expect(css).toContain(
				"body.zen-mode .wf-header.header:hover, body.zen-mode .wf-header.header:focus-within { opacity: 1; transform: translateY(0); }",
			);
		});

		it("dims every row but the current one", () =>
		{
			expect(css).toContain(
				"body.zen-mode .project > .name, body.zen-mode .project > .notes { transition: opacity 120ms ease, filter 120ms ease, color 120ms ease; }",
			);
			expect(css).toContain(
				"body.zen-mode.zen-mode--focused .project:not(.zen-mode-current) > .name, body.zen-mode.zen-mode--focused .project:not(.zen-mode-current) > .notes { color: var(--wf-text-secondary); opacity: 0.62; filter: saturate(0.25); }",
			);
		});

		it("leaves the header transition out, as upstream's undefined variable makes it instant", () =>
		{
			expect(css.includes("160ms")).toBe(false);
		});

		it("is imported by the app", () =>
		{
			expect(readFileSync(new URL("../src/client/app.tsx", import.meta.url), "utf8")).toContain(
				'import "./zen-mode.css";',
			);
		});
	});
});

describe("zen mode", () =>
{
	function fakeClassList()
	{
		const set = new Set<string>();
		return {
			add: (name: string) => void set.add(name),
			remove: (name: string) => void set.delete(name),
			contains: (name: string) => set.has(name),
			list: () => [...set],
		};
	}

	function setup(initial: {left: boolean; right: boolean})
	{
		const body = fakeClassList();
		const calls: string[] = [];
		const state =
		{
			left: initial.left,
			right: initial.right,
			now: 1000,
			active: null as object | null,
			editorFocused: false,
		};
		let rafCallback: (() => void) | null = null;
		const revealed: object[] = [];
		const deps: ZenDeps =
		{
			body,
			getLeftOpen: () => state.left,
			setLeftOpen: (open) =>
			{
				calls.push(`left:${open}`);
				state.left = open;
			},
			getRightOpen: () => state.right,
			setRightOpen: (open) =>
			{
				calls.push(`right:${open}`);
				state.right = open;
			},
			raf: (callback) =>
			{
				rafCallback = callback;
				return 1;
			},
			cancelRaf: () =>
			{
				rafCallback = null;
			},
			now: () => state.now,
			reveal: (target) => void revealed.push(target),
			activeElement: () => state.active,
			isEditorFocused: () => state.editorFocused,
		};
		const flush = () =>
		{
			const callback = rafCallback;
			rafCallback = null;
			callback?.();
		};
		return {
			zen: createZenController(deps),
			body,
			calls,
			state,
			revealed,
			flush,
		};
	}

	function row()
	{
		const list = fakeClassList();
		const target =
		{
			contains: (el: unknown) => el === target || el === inner,
			isConnected: true,
		};
		const inner = {};
		return {
			el:
			{
				classList: list,
			},
			target,
			inner,
			list,
		};
	}

	describe("zen mode controller", () =>
	{
		it("enters by adding the body class, closing both bars and snapshotting them", () =>
		{
			const {zen, body, calls} = setup(
				{
					left: true,
					right: true,
				},
			);
			zen.toggle();
			expect([zen.isOn(), body.list(), calls]).toStrictEqual([true, [ZEN], ["left:false", "right:false"]]);
		});

		it("moves the current row and dims the rest", () =>
		{
			const {zen, body} = setup(
				{
					left: false,
					right: false,
				},
			);
			const a = row();
			const b = row();
			zen.toggle();
			zen.onFocusRow(a.el, a.target);
			zen.onFocusRow(b.el, b.target);
			expect([a.list.list(), b.list.list(), body.list()]).toStrictEqual([[], [ZEN_CURRENT], [ZEN, ZEN_FOCUSED]]);
		});

		it("centres only while the target still holds focus, then ignores scroll for 250ms", () =>
		{
			const {zen, body, state, revealed, flush} = setup(
				{
					left: false,
					right: false,
				},
			);
			const a = row();
			zen.toggle();
			zen.onFocusRow(a.el, a.target);
			flush();
			expect(revealed).toStrictEqual([]);
			zen.onFocusRow(a.el, a.target);
			state.active = a.inner;
			flush();
			expect(revealed).toStrictEqual([a.target]);
			state.now += 100;
			zen.onScroll();
			expect(body.contains(ZEN_FOCUSED)).toBe(true);
			state.now += 200;
			zen.onScroll();
			expect(body.contains(ZEN_FOCUSED)).toBe(false);
		});

		it("blur with no editor focused undoes the dimming", () =>
		{
			const {zen, body, flush} = setup(
				{
					left: false,
					right: false,
				},
			);
			const a = row();
			zen.toggle();
			zen.onFocusRow(a.el, a.target);
			zen.onBlur();
			flush();
			expect([body.list(), a.list.list()]).toStrictEqual([[ZEN], []]);
		});

		it("blur keeps the dimming when an editor took focus", () =>
		{
			const {zen, body, state, flush} = setup(
				{
					left: false,
					right: false,
				},
			);
			const a = row();
			zen.toggle();
			zen.onFocusRow(a.el, a.target);
			state.editorFocused = true;
			zen.onBlur();
			flush();
			expect(body.list()).toStrictEqual([ZEN, ZEN_FOCUSED]);
		});

		it("exits by restoring the bars and removing every class; a second exit is a no-op", () =>
		{
			const {zen, body, calls} = setup(
				{
					left: true,
					right: true,
				},
			);
			const a = row();
			zen.toggle();
			zen.onFocusRow(a.el, a.target);
			zen.toggle();
			expect([zen.isOn(), body.list(), a.list.list(), calls]).toStrictEqual([
				false,
				[],
				[],
				["left:false", "right:false", "left:true", "right:true"],
			]);
			zen.exit();
			expect(calls).toHaveLength(4);
		});

		it("ignores row focus while off", () =>
		{
			const {zen, body} = setup(
				{
					left: false,
					right: false,
				},
			);
			const a = row();
			zen.onFocusRow(a.el, a.target);
			expect([body.list(), a.list.list()]).toStrictEqual([[], []]);
		});
	});

	describe("scrollCounts", () =>
	{
		const element = (tag: string, inProject: boolean, scroller: boolean, holdsProject: boolean) => (
		{
			tagName: tag,
			closest: (selector: string) =>
			{
				if (selector === ".project")
				{
					return inProject ? {} : null;
				}
				return scroller ? {} : null;
			},
			querySelector: () => (holdsProject ? {} : null),
		});

		it("counts the document, body, rows and pane scrollers, but not other scrollers", () =>
		{
			expect([
				scrollCounts(null),
				scrollCounts(element("BODY", false, false, false)),
				scrollCounts(element("DIV", true, false, false)),
				scrollCounts(element("DIV", false, true, true)),
				scrollCounts(element("DIV", false, true, false)),
				scrollCounts(element("DIV", false, false, false)),
			]).toStrictEqual([true, true, true, true, false, false]);
		});
	});
});
