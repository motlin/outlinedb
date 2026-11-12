// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {editableText} from "../src/client/components/editable-text.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {is, pop, resetPopupsForTests} from "../src/client/popups.js";
import {nodeKeys} from "../src/client/node-cache.js";
import type {NodeResponse} from "../src/node-types.js";

declare global {
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("editable text resting", () => {
	let root: Root | undefined;

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.resolve(Response.json({}))),
		);
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		vi.unstubAllGlobals();
	});

	/** The query keys mounting one row name puts in the cache. */
	function mountedQueryKeys(isEditing: boolean): string[] {
		const queryClient = new QueryClient();
		root = createRoot(document.createElement("div"));
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: queryClient},
					createElement(editableText, {
						nodeId: "alice",
						initialValue: "Alice",
						parentId: null,
						priority: 0,
						isEditing,
					}),
				),
			);
		});
		return queryClient
			.getQueryCache()
			.getAll()
			.map((query) => String(query.queryKey[0]));
	}

	describe("EditableText at rest", () => {
		it("mounts a resting row with only the date settings and account it renders pills with, leaving the editor's queries to the edited row", () => {
			const resting = mountedQueryKeys(false);
			act(() => {
				root?.unmount();
			});
			expect({resting, editing: mountedQueryKeys(true)}).toStrictEqual({
				resting: ["preferences", "account"],
				editing: [
					"preferences",
					"account",
					"tag-autocomplete",
					"calendar-days",
					"calendar-days",
					"calendar-days",
				],
			});
		});
	});

	const TIMED_PILL =
		'<time startYear="2026" startMonth="10" startDay="2" startHour="14" startMinute="30">Fri, Oct 2, 2026 at 2:30pm</time>';

	/** Mounts a resting row, clicks its pill, then runs `act` on the open picker; returns the saved name and the store's edit state. */
	async function pickOnRestingPill(
		initialValue: string,
		choose: () => void,
	): Promise<{names: string[]; editingId: string | null; caret: number | null}> {
		const names: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				if (typeof init?.body === "string") {
					const body: unknown = JSON.parse(init.body);
					if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") {
						names.push(body.name);
					}
				}
				return Promise.resolve(Response.json({days: []}));
			}),
		);
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: new QueryClient()},
					createElement(editableText, {
						nodeId: "alice",
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: false,
					}),
				),
			);
			await Promise.resolve();
		});
		await act(async () => {
			host.querySelector("time")?.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
			await Promise.resolve();
		});
		await act(async () => {
			choose();
			await Promise.resolve();
		});
		const {editingId, editingCaretOffset} = useOutlineStore.getState();
		return {names, editingId, caret: editingCaretOffset};
	}

	describe("EditableText resting pill picker", () => {
		it("applying a day replaces the pill, drops the hours and edits the row with the caret after the pill", async () => {
			const result = await pickOnRestingPill(`dpHours ${TIMED_PILL}`, () => {
				const five = [...document.querySelectorAll<HTMLElement>('[data-date-picker-day-button="true"]')].find(
					(button) => button.textContent === "5",
				);
				five?.click();
			});
			expect(result).toStrictEqual({
				names: ['dpHours <time startYear="2026" startMonth="10" startDay="5">Mon, Oct 5, 2026</time>'],
				editingId: "alice",
				caret: 9,
			});
		});

		it("Remove date edits the row with the caret where the pill was", async () => {
			const result = await pickOnRestingPill(`dpOtherYear ${TIMED_PILL}`, () => {
				const remove = [...document.querySelectorAll<HTMLElement>(".menuItem")].find(
					(row) => row.textContent === "Remove date",
				);
				remove?.click();
			});
			expect(result).toStrictEqual({names: ["dpOtherYear "], editingId: "alice", caret: 12});
		});
	});
});

describe("editable text tag teaser", () => {
	let root: Root | undefined;
	let host: HTMLDivElement | undefined;

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.resolve(Response.json({}))),
		);
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		host?.remove();
		root = undefined;
		host = undefined;
		for (const element of document.body.querySelectorAll(".flyout, .hidden")) {
			element.remove();
		}
		resetPopupsForTests();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function mountRow(): HTMLElement {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: new QueryClient()},
					createElement(editableText, {
						nodeId: "alice",
						initialValue: "Alice #todo later",
						parentId: null,
						priority: 0,
						isEditing: false,
					}),
				),
			);
		});
		const content = host.querySelector<HTMLElement>(".innerContentContainer");
		if (!content) {
			throw new Error("no resting content");
		}
		return content;
	}

	function tagOf(content: HTMLElement): HTMLElement {
		const tag = content.querySelector<HTMLElement>(".contentTag");
		if (!tag) {
			throw new Error("no rendered tag");
		}
		return tag;
	}

	function hover(target: Element): void {
		act(() => {
			target.dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
		});
	}

	function teaserOpen(): boolean {
		return document.querySelector(".tag-color-teaser") !== null;
	}

	function advance(ms: number): void {
		act(() => {
			vi.advanceTimersByTime(ms);
		});
	}

	describe("tag color teaser", () => {
		it("opens on tag hover and closes 150ms after the pointer moves from the tag onto plain text in the same row", () => {
			const content = mountRow();
			hover(tagOf(content));
			const opened = teaserOpen();
			hover(content);
			const justAfter = teaserOpen();
			advance(150);
			expect({opened, justAfter, after: teaserOpen()}).toStrictEqual({
				opened: true,
				justAfter: true,
				after: false,
			});
		});

		it("stays open when the pointer returns to the tag before the hide delay ends", () => {
			const content = mountRow();
			hover(tagOf(content));
			hover(content);
			advance(100);
			hover(tagOf(content));
			advance(200);
			expect(teaserOpen()).toBe(true);
		});

		it("closes when the caret moves", () => {
			const content = mountRow();
			hover(tagOf(content));
			const opened = teaserOpen();
			act(() => {
				document.dispatchEvent(new Event("selectionchange"));
			});
			expect({opened, after: teaserOpen()}).toStrictEqual({opened: true, after: false});
		});

		it("closes when the editor blurs", () => {
			const content = mountRow();
			hover(tagOf(content));
			const opened = teaserOpen();
			act(() => {
				document.body.dispatchEvent(new FocusEvent("focusout", {bubbles: true}));
			});
			expect({opened, after: teaserOpen()}).toStrictEqual({opened: true, after: false});
		});

		it("opens beside the always-mounted hidden search-helpers flyout", () => {
			const content = mountRow();
			const hidden = document.createElement("div");
			hidden.className = "hidden";
			hidden.innerHTML = '<div class="flyout menu"></div>';
			document.body.append(hidden);
			hover(tagOf(content));
			expect({teaser: teaserOpen(), registered: is("TAG_COLOR_TEASER_POPUP")}).toStrictEqual({
				teaser: true,
				registered: true,
			});
		});

		it("opens while an unregistered flyout such as the tag autocomplete is visible", () => {
			const content = mountRow();
			const menu = document.createElement("div");
			menu.className = "flyout menu";
			document.body.append(menu);
			hover(tagOf(content));
			expect(teaserOpen()).toBe(true);
		});

		it("does not open while the selection toolbar is registered", () => {
			const content = mountRow();
			pop("CTX_MENU_POPUP");
			hover(tagOf(content));
			expect(teaserOpen()).toBe(false);
		});

		it("unregisters when the teaser closes", () => {
			const content = mountRow();
			hover(tagOf(content));
			act(() => {
				document.dispatchEvent(new Event("selectionchange"));
			});
			expect(is("TAG_COLOR_TEASER_POPUP")).toBe(false);
		});

		it("does not open while a modal is open", () => {
			const content = mountRow();
			useOutlineStore.setState({jumpMenuOpen: true});
			hover(tagOf(content));
			expect(teaserOpen()).toBe(false);
		});
	});
});

describe("editable text vertical", () => {
	let root: Root | undefined;

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.resolve(Response.json({}))),
		);
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		vi.unstubAllGlobals();
	});

	function row(id: string, name: string): NodeResponse {
		return {
			id,
			parent_id: "zoom",
			name,
			note: null,
			priority: 0,
			data: {layoutMode: null},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
		};
	}

	/** Mounts row A's editor under a zoom root whose children are A and B, editing `editingId`. */
	function mountEditing(editingId: string): HTMLElement {
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children("zoom"), [row("A", "Alpha"), row("B", "Bravo")]);
		useOutlineStore.setState({
			zoomedNodeId: "zoom",
			expandedIds: new Set(),
			showCompleted: true,
			editingId,
			editingCaretOffset: 3,
		});
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const name = editingId === "A" ? "Alpha" : "Bravo";
		act(() => {
			root?.render(
				createElement(
					QueryClientProvider,
					{client: queryClient},
					createElement(editableText, {
						nodeId: editingId,
						initialValue: name,
						parentId: "zoom",
						priority: 0,
						isEditing: true,
					}),
				),
			);
		});
		const editor = container.querySelector<HTMLElement>("[contenteditable]");
		if (!editor) {
			throw new Error("no editor mounted");
		}
		return editor;
	}

	function arrowDown(editor: HTMLElement): KeyboardEvent {
		const event = new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true, cancelable: true});
		act(() => {
			editor.dispatchEvent(event);
		});
		return event;
	}

	describe("Down at a row's last line", () => {
		it("continues in the next row at offset 0, not x-preserving or select-all", () => {
			arrowDown(mountEditing("A"));
			const {editingId, editingCaretOffset} = useOutlineStore.getState();
			expect({editingId, editingCaretOffset}).toStrictEqual({editingId: "B", editingCaretOffset: 0});
		});

		it("is left native on the last row", () => {
			const event = arrowDown(mountEditing("B"));
			expect({
				defaultPrevented: event.defaultPrevented,
				editingId: useOutlineStore.getState().editingId,
			}).toStrictEqual({
				defaultPrevented: false,
				editingId: "B",
			});
		});
	});
});
