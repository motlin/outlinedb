import {describe, expect, it} from "vite-plus/test";
import {shouldClearSelectionOnPageMouseDown} from "../src/client/page-mousedown.js";
import {
	DOCUMENT_END_HEIGHT,
	PAGE_BREAKPOINT,
	getPagePadding,
	pageClassName,
	pageContainerClassName,
	pageStyle,
} from "../src/client/page-style.js";

describe("page mousedown", () => {
	const base = {
		selectionActive: true,
		button: 0,
		meta: false,
		alt: false,
		ctrl: false,
		shift: false,
		onSelectedBullet: false,
	};

	describe("shouldClearSelectionOnPageMouseDown", () => {
		it("is true only for a plain left press with a selection, off a selected bullet", () => {
			expect({
				plain: shouldClearSelectionOnPageMouseDown(base),
				noSelection: shouldClearSelectionOnPageMouseDown({...base, selectionActive: false}),
				right: shouldClearSelectionOnPageMouseDown({...base, button: 2}),
				meta: shouldClearSelectionOnPageMouseDown({...base, meta: true}),
				alt: shouldClearSelectionOnPageMouseDown({...base, alt: true}),
				ctrl: shouldClearSelectionOnPageMouseDown({...base, ctrl: true}),
				shift: shouldClearSelectionOnPageMouseDown({...base, shift: true}),
				bullet: shouldClearSelectionOnPageMouseDown({...base, onSelectedBullet: true}),
			}).toStrictEqual({
				plain: true,
				noSelection: false,
				right: false,
				meta: false,
				alt: false,
				ctrl: false,
				shift: false,
				bullet: false,
			});
		});
	});
});

describe("page style", () => {
	describe("getPagePadding", () => {
		it("uses 80/136 from 720px up and 56/56 below, like upstream's ln2", () => {
			expect({
				wide: getPagePadding(1440),
				atBreakpoint: getPagePadding(720),
				narrow: getPagePadding(719),
			}).toStrictEqual({
				wide: {left: 80, right: 136},
				atBreakpoint: {left: 80, right: 136},
				narrow: {left: 56, right: 56},
			});
		});

		it("exposes upstream's constants", () => {
			expect({breakpoint: PAGE_BREAKPOINT, documentEnd: DOCUMENT_END_HEIGHT}).toStrictEqual({
				breakpoint: 720,
				documentEnd: 380,
			});
		});
	});

	describe("pageStyle", () => {
		const base = {
			minHeight: "calc(100vh - 146px)",
			borderRadius: 6,
			maxWidth: "none",
			paddingLeft: 80,
			paddingRight: 136,
			paddingTop: 24,
			marginTop: 72,
			paddingBottom: 24,
		};

		it("builds upstream's full-width inline style", () => {
			expect(pageStyle({fullWidth: true, width: 1440, searching: false})).toStrictEqual(base);
		});

		it("caps the content box at 700 when full width is off", () => {
			expect(pageStyle({fullWidth: false, width: 1440, searching: false})).toStrictEqual({
				...base,
				maxWidth: 700,
			});
		});

		it("adds search bottom room and narrow padding", () => {
			expect(pageStyle({fullWidth: false, width: 719, searching: true})).toStrictEqual({
				...base,
				maxWidth: 700,
				paddingLeft: 56,
				paddingRight: 56,
				paddingBottom: 70,
			});
		});

		it("keeps the desktop top margin at 72 while offline", () => {
			expect(pageStyle({fullWidth: true, width: 1440, searching: false, offline: true}).marginTop).toBe(72);
		});
	});

	describe("pageClassName", () => {
		const shell =
			"relative mx-auto flex flex-col select-none bg-primary shadow-[0_0_15px_var(--wf-border-ambient)] [-webkit-text-size-adjust:none] print:block page active";

		it("returns upstream's class string, then searching and showCompleted", () => {
			expect({
				idle: pageClassName({searching: false, showCompleted: false}),
				both: pageClassName({searching: true, showCompleted: true}),
			}).toStrictEqual({idle: shell, both: `${shell} searching showCompleted`});
		});
	});

	describe("pageContainerClassName", () => {
		it("is upstream's desktop container class string", () => {
			expect(pageContainerClassName()).toBe(
				"min-h-screen bg-[var(--wf-background-ambient)] bg-fixed [background-image:var(--wf-image-ambient)] pageContainer",
			);
		});
	});
});
