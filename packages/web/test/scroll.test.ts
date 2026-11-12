import {describe, expect, it} from "vite-plus/test";
import {
	installScrollRestoration,
	oweAppStepScroll,
	poppedScrollY,
	restorePoppedScroll,
} from "../src/client/scroll-restoration.js";
import type {ScrollWindow} from "../src/client/scroll-restoration.js";
import {centeredScrollTop} from "../src/client/scroll-reveal.js";
import {focusCenters, focusCenterNext} from "../src/client/quiet-focus.js";

describe("scroll restoration", () => {
	const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";

	/** A window whose history entries are `{key}` states at `/#/<id>` URLs, and whose scrolls are recorded. */
	class FakeWindow extends EventTarget implements ScrollWindow {
		scrollY = 0;
		stored = new Map<string, string>();
		sessionStorage = {
			getItem: (key: string) => this.stored.get(key) ?? null,
			setItem: (key: string, value: string) => {
				this.stored.set(key, value);
			},
		};
		scrolls: number[] = [];
		history: {state: unknown; scrollRestoration: ScrollRestoration} = {state: null, scrollRestoration: "auto"};
		location = {href: "http://localhost/", hash: ""};

		scrollTo(_x: number, y: number): void {
			this.scrolls.push(y);
			this.scrollY = y;
		}

		/** The user scrolls the current entry to `y`. */
		scroll(y: number): void {
			this.scrollY = y;
			this.dispatchEvent(new Event("scroll"));
		}

		/** The app pushes entry `key` showing `hash`. */
		push(key: string, hash: string): void {
			this.enter(key, hash);
		}

		/** Browser Back/Forward to entry `key` showing `hash`. */
		pop(key: string, hash: string): void {
			this.enter(key, hash);
			this.dispatchEvent(new Event("popstate"));
		}

		private enter(key: string, hash: string): void {
			this.history.state = {key};
			this.location = {href: `http://localhost/${hash}`, hash};
		}
	}

	/** Alice's entry scrolled to 300, then Bob's pushed and left at the top. */
	function scrolledAliceThenBob(): {win: FakeWindow; uninstall: () => void} {
		const win = new FakeWindow();
		const uninstall = installScrollRestoration(win);
		win.push("a", "#/aaaaaaaaaaaa");
		win.scroll(300);
		win.push("b", "#/bbbbbbbbbbbb");
		win.scroll(0);
		win.scrolls = [];
		return {win, uninstall};
	}

	describe("scroll restoration", () => {
		it("takes over the browser's restoration while installed", () => {
			const win = new FakeWindow();
			const uninstall = installScrollRestoration(win);
			const installed = win.history.scrollRestoration;
			uninstall();
			expect({installed, uninstalled: win.history.scrollRestoration}).toStrictEqual({
				installed: "manual",
				uninstalled: "auto",
			});
		});

		it("restores a popped entry's scroll only once its view shows, and only once", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.pop("a", "#/aaaaaaaaaaaa");
			restorePoppedScroll(BOB, win);
			const whileHeld = [...win.scrolls];
			restorePoppedScroll(ALICE, win);
			restorePoppedScroll(ALICE, win);
			uninstall();
			expect({whileHeld, scrolls: win.scrolls}).toStrictEqual({whileHeld: [], scrolls: [300]});
		});

		it("restores the entry left by Back when Forward returns to it", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.pop("a", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			win.pop("b", "#/bbbbbbbbbbbb");
			restorePoppedScroll(BOB, win);
			uninstall();
			expect(win.scrolls).toStrictEqual([300, 0]);
		});

		it("restores a popped entry to its location's last scroll, not the entry's own", () => {
			const win = new FakeWindow();
			const uninstall = installScrollRestoration(win);
			win.push("k1", "#/aaaaaaaaaaaa");
			win.scroll(500);
			win.push("k2", "#/bbbbbbbbbbbb");
			win.push("k3", "#/aaaaaaaaaaaa");
			win.scroll(200);
			win.push("k4", "#/bbbbbbbbbbbb");
			win.pop("k1", "#/aaaaaaaaaaaa");
			const scrollY = poppedScrollY(ALICE, win);
			uninstall();
			expect(scrollY).toBe(200);
		});

		it("scrolls an entry it never saw to the top", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.scroll(500);
			win.scrolls = [];
			win.pop("c", "");
			restorePoppedScroll(null, win);
			uninstall();
			expect(win.scrolls).toStrictEqual([0]);
		});

		it("drops a popped entry's restore once a push leaves it", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.pop("a", "#/aaaaaaaaaaaa");
			win.push("d", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			uninstall();
			expect(win.scrolls).toStrictEqual([]);
		});

		it("reports the popped entry's scroll for its own location until it is restored", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.pop("a", "#/aaaaaaaaaaaa");
			const popped = {alice: poppedScrollY(ALICE, win), bob: poppedScrollY(BOB, win)};
			restorePoppedScroll(ALICE, win);
			const restored = poppedScrollY(ALICE, win);
			uninstall();
			expect({popped, restored}).toStrictEqual({popped: {alice: 300, bob: 0}, restored: 0});
		});

		it("restores the entry a reload returns to once its view shows", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.pop("a", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			win.dispatchEvent(new Event("pagehide"));
			uninstall();
			const reloaded = new FakeWindow();
			reloaded.stored = win.stored;
			reloaded.push("a", "#/aaaaaaaaaaaa");
			const uninstallReloaded = installScrollRestoration(reloaded);
			restorePoppedScroll(ALICE, reloaded);
			uninstallReloaded();
			expect(reloaded.scrolls).toStrictEqual([300]);
		});

		it("restores the scroll an app Back's location was left at, though Back pushes a new entry", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			// The step zooms (and so loads rows down to the owed scroll) before it pushes the target's entry.
			oweAppStepScroll({id: "aaaaaaaaaaaa", query: null});
			const owed = poppedScrollY(ALICE, win);
			win.push("c", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			uninstall();
			expect({owed, scrolls: win.scrolls}).toStrictEqual({owed: 300, scrolls: [300]});
		});

		it("restores the latest scroll of a location visited twice, and the top for one never scrolled", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			win.push("c", "#/aaaaaaaaaaaa");
			win.scroll(120);
			win.push("d", "#/cccccccccccc");
			oweAppStepScroll({id: "aaaaaaaaaaaa", query: null});
			win.push("e", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			oweAppStepScroll({id: "dddddddddddd", query: null});
			win.push("f", "#/dddddddddddd");
			restorePoppedScroll("5e6f7a8b-0b7d-4e5a-8c3f-dddddddddddd", win);
			uninstall();
			expect(win.scrolls).toStrictEqual([120, 0]);
		});

		it("drops an app step's restore once a later push leaves its entry", () => {
			const {win, uninstall} = scrolledAliceThenBob();
			oweAppStepScroll({id: "aaaaaaaaaaaa", query: null});
			win.push("c", "#/aaaaaaaaaaaa");
			restorePoppedScroll(BOB, win);
			win.push("d", "#/aaaaaaaaaaaa");
			restorePoppedScroll(ALICE, win);
			uninstall();
			expect(win.scrolls).toStrictEqual([]);
		});
	});
});

describe("scroll reveal", () => {
	const view = {rowHeight: 28, viewportHeight: 714, maxScroll: 517};

	describe("centeredScrollTop", () => {
		it("centers a row below the fold", () => {
			expect(centeredScrollTop({...view, rowTop: 555, scrollY: 0})).toBe(212);
		});

		it("clamps to the top", () => {
			expect(centeredScrollTop({...view, rowTop: 144, scrollY: 0})).toBe(0);
		});

		it("centers relative to the current scroll", () => {
			expect(centeredScrollTop({...view, rowTop: 300, scrollY: 400})).toBe(357);
		});

		it("clamps to the bottom", () => {
			expect(centeredScrollTop({...view, rowTop: 680, scrollY: 500})).toBe(517);
		});
	});

	describe("focusCenterNext", () => {
		it("centers only the named row, once", () => {
			focusCenterNext("a");
			expect([focusCenters("b"), focusCenters("a"), focusCenters("a")]).toStrictEqual([false, true, false]);
		});
	});
});
