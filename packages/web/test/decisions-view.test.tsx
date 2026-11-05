// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {DecisionPage} from "../src/server/decisions.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {hideLoadingScreenOnce} = vi.hoisted(() => ({hideLoadingScreenOnce: vi.fn<() => void>()}));
vi.mock("../src/client/loading-screen.js", () => ({hideLoadingScreenOnce}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {DecisionPageView} = await import("../src/client/components/decisions-view.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

const PAGE: DecisionPage = {
	slug: "meetings",
	title: "Meeting follow-ups",
	intro: "Pick one per item",
	groups: [
		{
			heading: "1:1 Alice - Mon Oct 26",
			link: "https://example.com/meeting",
			items: [
				{
					id: "a-1",
					title: "Send the deck",
					body: ["Alice asked for the deck", "<b>not html</b>"],
					links: [
						{label: "Meeting", href: "https://example.com/meeting"},
						{label: "Task", href: "https://workflowy.com/#/abc123"},
					],
					options: [
						{value: "inbox", label: "Add to inbox", description: "File it"},
						{value: "skip", label: "Skip"},
					],
					default: "inbox",
					answer: null,
				},
				{
					id: "a-2",
					title: "Book the room",
					body: [],
					links: [],
					options: [{value: "skip", label: "Skip"}],
					default: null,
					answer: {choice: "skip", note: "", answeredAt: "2026-10-27T14:00:00.000Z"},
				},
			],
		},
		{
			heading: "Standup - Tue Oct 27",
			items: [
				{
					id: "b-1",
					title: "Review the PR",
					body: ["Bob asked for a review", "overdue 7d, skipped 1 runs since 2026-10-24"],
					links: [],
					options: [
						{value: "inbox", label: "Add to inbox"},
						{value: "skip", label: "Skip"},
					],
					default: null,
					answer: null,
				},
			],
		},
	],
	submittedAt: null,
};

/** PAGE with the given item ids already answered and every other item unanswered. */
function pageAnswering(ids: string[]): DecisionPage {
	return {
		...PAGE,
		groups: PAGE.groups.map((group) => ({
			...group,
			items: group.items.map((item) => ({
				...item,
				answer: ids.includes(item.id)
					? {choice: "skip", note: "", answeredAt: "2026-10-27T14:00:00.000Z"}
					: null,
			})),
		})),
	};
}

interface Call {
	method: string;
	url: string;
	body: unknown;
}

let root: Root | undefined;
let host: HTMLElement | undefined;
let calls: Call[] = [];

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await act(async () => {
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	calls = [];
	useOutlineStore.getState().setTheme("system");
	localStorage.clear();
});

/** Stub fetch: GET answers the page, writes answer `write(call)` (default: echo a saved answer). */
function stubFetch(write: (call: Call) => Response = defaultWrite, page: DecisionPage = PAGE): void {
	vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
		const method = init.method ?? "GET";
		const call = {method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined};
		calls.push(call);
		return Promise.resolve(method === "GET" ? Response.json(page) : write(call));
	});
}

function defaultWrite(call: Call): Response {
	return call.method === "POST"
		? Response.json({submittedAt: "2026-10-27T15:00:00.000Z"})
		: Response.json({answer: {...(call.body as object), answeredAt: "2026-10-27T15:00:00.000Z"}});
}

async function flush(): Promise<void> {
	await act(async () => {
		for (let index = 0; index < 5; index++) {
			await Promise.resolve();
		}
	});
}

async function mount(): Promise<void> {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(createElement(DecisionPageView, {slug: "meetings"}));
		await Promise.resolve();
	});
	await flush();
}

function card(id: string): HTMLElement {
	const element = host?.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
	if (!element) {
		throw new Error(`no card ${id}`);
	}
	return element;
}

function classesOf(element: Element | null): string[] {
	return [...(element?.children ?? [])].map((child) => child.className);
}

/** The card's two columns and what each holds, by class name. */
function cardLayout(id: string): {card: string[]; main: string[]; side: string[]} {
	const element = card(id);
	return {
		card: classesOf(element),
		main: classesOf(element.querySelector(":scope > .decisions-card-main")),
		side: classesOf(element.querySelector(":scope > .decisions-card-side")),
	};
}

/** How the All done page shows a submission time: the viewer's local clock time. */
function submittedTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
}

function text(selector: string, within: ParentNode | undefined = host): string[] {
	return [...(within?.querySelectorAll(selector) ?? [])].map((element) => element.textContent);
}

function shownCards(): string[] {
	return [...(host?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])].map(
		(element) => element.dataset.itemId ?? "",
	);
}

function radios(id: string): [string, boolean][] {
	return [...card(id).querySelectorAll<HTMLInputElement>("input[type=radio]")].map((radio) => [
		radio.value,
		radio.checked,
	]);
}

function button(label: string): HTMLButtonElement {
	const found = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
		(element) => element.textContent === label,
	);
	if (!found) {
		throw new Error(`no button ${label}`);
	}
	return found;
}

function themeButtons(): HTMLButtonElement[] {
	return [...(host?.querySelectorAll<HTMLButtonElement>(".decisions-theme button") ?? [])];
}

function themeButton(label: string): HTMLButtonElement | undefined {
	return themeButtons().find((element) => element.getAttribute("aria-label") === label);
}

function pressedThemes(): (string | null)[] {
	return themeButtons()
		.filter((element) => element.getAttribute("aria-pressed") === "true")
		.map((element) => element.getAttribute("aria-label"));
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
	if (!element) {
		throw new Error("nothing to click");
	}
	await act(async () => {
		element.click();
		await Promise.resolve();
	});
	await flush();
}

async function key(target: Element, name: string): Promise<void> {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", {key: name, bubbles: true}));
		await Promise.resolve();
	});
	await flush();
}

async function typeNote(textarea: HTMLTextAreaElement, values: string[]): Promise<void> {
	for (const value of values) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
			textarea.dispatchEvent(new Event("input", {bubbles: true}));
			await Promise.resolve();
		});
	}
}

describe("DecisionPageView", () => {
	it("retries the page load through a dev API restart instead of showing a JSON parse error", async () => {
		let gets = 0;
		vi.stubGlobal("fetch", async () => {
			gets++;
			return Promise.resolve(gets === 1 ? new Response("", {status: 200}) : Response.json(PAGE));
		});
		await mount();
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 400);
			});
		});
		await flush();
		expect({gets, title: text("h1"), errors: text("[role=alert]")}).toStrictEqual({
			gets: 2,
			title: ["Meeting follow-ups"],
			errors: [],
		});
	});

	it("dismisses the boot loading screen, which only the outline view hid before", async () => {
		hideLoadingScreenOnce.mockClear();
		stubFetch();
		await mount();
		expect(hideLoadingScreenOnce.mock.calls).toStrictEqual([[]]);
	});

	it("shows one card at a time with its group heading, starting at the first unanswered card", async () => {
		stubFetch();
		await mount();
		const first = card("a-1");
		expect({
			title: text("h1"),
			intro: text(".decisions-intro"),
			cards: shownCards(),
			heading: text(".decisions-group-heading"),
			headingLink: host?.querySelector(".decisions-group-heading a")?.getAttribute("href"),
			cardTitle: text("h2.decisions-card-title", first),
			headingInCard: text(".decisions-group-heading", first),
			legends: first.querySelectorAll("legend").length,
			radioGroupLabel: document.getElementById(
				first.querySelector("[role=radiogroup]")?.getAttribute("aria-labelledby") ?? "",
			)?.textContent,
			bar: ["value", "max", "aria-label"].map((name) =>
				host?.querySelector("progress.decisions-bar")?.getAttribute(name),
			),
			body: text(".decisions-body-line", first),
			bodyHtmlElements: first.querySelectorAll(".decisions-body-line b").length,
			links: [...first.querySelectorAll(".decisions-links a")].map((link) => [
				link.textContent,
				link.getAttribute("href"),
				link.getAttribute("target"),
				link.getAttribute("rel"),
				link.getAttribute("title"),
				link.querySelector(".decisions-link-icon")?.getAttribute("data-icon"),
				link.querySelector("img.decisions-link-icon")?.getAttribute("src"),
			]),
			radios: radios("a-1"),
			optionLabels: text(".decisions-option-label", first),
			optionKeys: text(".decisions-option-key", first),
			optionDescriptions: text(".decisions-option-description", first),
			suggested: text(".decisions-suggested", first),
			position: text(".decisions-position"),
			progress: text(".decisions-progress"),
			jumpStrips: host?.querySelectorAll(".decisions-jump").length,
			allAnswered: text(".decisions-all-answered"),
			calls,
		}).toStrictEqual({
			title: ["Meeting follow-ups"],
			intro: ["Pick one per item"],
			cards: ["a-1"],
			heading: ["1:1 Alice - Mon Oct 26"],
			headingLink: "https://example.com/meeting",
			cardTitle: ["Send the deck"],
			headingInCard: ["1:1 Alice - Mon Oct 26"],
			legends: 0,
			radioGroupLabel: "Send the deck",
			bar: ["1", "3", "Answered"],
			body: ["Alice asked for the deck", "<b>not html</b>"],
			bodyHtmlElements: 0,
			links: [
				[
					"Meeting",
					"https://example.com/meeting",
					"_blank",
					"noopener noreferrer",
					"Meeting",
					"external",
					undefined,
				],
				[
					"Task",
					"https://workflowy.com/#/abc123",
					"_blank",
					"noopener noreferrer",
					"Task",
					"workflowy",
					"/favicon.png",
				],
			],
			radios: [
				["inbox", false],
				["skip", false],
			],
			optionLabels: ["Add to inbox", "Skip"],
			optionKeys: ["1", "2"],
			optionDescriptions: ["File it"],
			suggested: ["suggested"],
			position: ["Card 1 of 3"],
			progress: ["1 of 3 answered"],
			jumpStrips: 0,
			allAnswered: [],
			calls: [{method: "GET", url: "/api/v1/decisions/meetings", body: undefined}],
		});
	});

	it("shows a card's photos above its body as lazy thumbnails that open the full image in a new tab", async () => {
		const [group] = PAGE.groups;
		const [first] = group.items;
		const images = [
			{src: "status-2026-11-03/2026-10-31_1356_img3589.jpg", alt: "The garage shelf"},
			{src: "with space/b#2.png", alt: "Second angle"},
		];
		stubFetch(defaultWrite, {...PAGE, groups: [{...group, items: [{...first, images}]}]});
		await mount();
		const gallery = card("a-1").querySelector(".decisions-images");
		expect({
			beforeBody: gallery?.nextElementSibling?.className,
			thumbnails: [...(gallery?.querySelectorAll("a") ?? [])].map((link) => {
				const image = link.querySelector("img");
				return [
					link.getAttribute("href"),
					link.getAttribute("target"),
					link.getAttribute("rel"),
					image?.getAttribute("src"),
					image?.getAttribute("alt"),
					image?.getAttribute("loading"),
					image?.className,
				];
			}),
		}).toStrictEqual({
			beforeBody: "decisions-body",
			thumbnails: [
				[
					"/api/v1/decisions/images/status-2026-11-03/2026-10-31_1356_img3589.jpg",
					"_blank",
					"noopener noreferrer",
					"/api/v1/decisions/images/status-2026-11-03/2026-10-31_1356_img3589.jpg",
					"The garage shelf",
					"lazy",
					"decisions-image",
				],
				[
					"/api/v1/decisions/images/with%20space/b%232.png",
					"_blank",
					"noopener noreferrer",
					"/api/v1/decisions/images/with%20space/b%232.png",
					"Second angle",
					"lazy",
					"decisions-image",
				],
			],
		});
	});

	it("shows a card's videos in the media row as inline players that load only metadata", async () => {
		const [group] = PAGE.groups;
		const [first] = group.items;
		const images = [{src: "s/still.jpg", alt: "Still"}];
		const videos = [{src: "s/clip one.mp4", poster: "s/clip one.jpg"}, {src: "s/b#2.webm"}];
		stubFetch(defaultWrite, {...PAGE, groups: [{...group, items: [{...first, images, videos}]}]});
		await mount();
		const row = card("a-1").querySelector(".decisions-images");
		expect({
			beforeBody: row?.nextElementSibling?.className,
			children: [...(row?.children ?? [])].map((element) => element.tagName),
			players: [...(row?.querySelectorAll("video") ?? [])].map((video) => [
				video.getAttribute("src"),
				video.getAttribute("poster"),
				video.hasAttribute("controls"),
				video.hasAttribute("playsinline"),
				video.getAttribute("preload"),
				video.className,
			]),
		}).toStrictEqual({
			beforeBody: "decisions-body",
			children: ["A", "VIDEO", "VIDEO"],
			players: [
				[
					"/api/v1/decisions/media/s/clip%20one.mp4",
					"/api/v1/decisions/images/s/clip%20one.jpg",
					true,
					true,
					"metadata",
					"decisions-video",
				],
				["/api/v1/decisions/media/s/b%232.webm", null, true, true, "metadata", "decisions-video"],
			],
		});
	});

	it("shows a media row for an item with only videos", async () => {
		const [group] = PAGE.groups;
		const [first] = group.items;
		stubFetch(defaultWrite, {...PAGE, groups: [{...group, items: [{...first, videos: [{src: "clip.mov"}]}]}]});
		await mount();
		expect(cardLayout("a-1").main).toStrictEqual([
			"decisions-group-heading",
			"decisions-card-title",
			"decisions-images",
			"decisions-body",
			"decisions-links",
		]);
	});

	it("leaves space and arrow keys to a focused video's playback controls, but still answers with number keys", async () => {
		const [group, standup] = PAGE.groups;
		const [first, ...rest] = group.items;
		stubFetch(defaultWrite, {
			...PAGE,
			groups: [{...group, items: [{...first, videos: [{src: "clip.mp4"}]}, ...rest]}, standup],
		});
		await mount();
		const video = card("a-1").querySelector("video")!;
		const presses: boolean[] = [];
		for (const name of [" ", "ArrowRight", "ArrowLeft"]) {
			const event = new KeyboardEvent("keydown", {key: name, bubbles: true, cancelable: true});
			// One act at a time: overlapping acts would interleave React's update queue.
			// oxlint-disable-next-line no-await-in-loop
			await act(async () => {
				video.dispatchEvent(event);
				await Promise.resolve();
			});
			presses.push(event.defaultPrevented);
		}
		await flush();
		const afterPlayback = {calls: calls.slice(1), cards: shownCards(), radios: radios("a-1"), presses};
		await key(video, "2");
		expect({afterPlayback, afterDigit: {calls: calls.slice(1), cards: shownCards()}}).toStrictEqual({
			afterPlayback: {
				calls: [],
				cards: ["a-1"],
				radios: [
					["inbox", false],
					["skip", false],
				],
				presses: [false, false, false],
			},
			afterDigit: {
				calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: "skip", note: ""}}],
				cards: ["b-1"],
			},
		});
	});

	it("renders no photo row for an item without images", async () => {
		stubFetch();
		await mount();
		expect(cardLayout("a-1")).toStrictEqual({
			card: ["decisions-card-main", "decisions-card-side"],
			main: ["decisions-group-heading", "decisions-card-title", "decisions-body", "decisions-links"],
			side: ["decisions-options", "decisions-note-label", "decisions-note", "decisions-status", "decisions-nav"],
		});
	});

	it("resumes at the first unanswered card on reload", async () => {
		stubFetch(defaultWrite, pageAnswering(["a-1", "a-2"]));
		await mount();
		expect({
			cards: shownCards(),
			heading: text(".decisions-group-heading"),
			headingLinks: host?.querySelectorAll(".decisions-group-heading a").length,
			position: text(".decisions-position"),
			body: text(".decisions-body-line"),
			numbers: [...(host?.querySelectorAll<HTMLElement>(".decisions-body-line .decisions-num") ?? [])].map(
				(element) => [element.textContent, element.dataset.kind],
			),
		}).toStrictEqual({
			cards: ["b-1"],
			heading: ["Standup - Tue Oct 27"],
			headingLinks: 0,
			position: ["Card 3 of 3"],
			body: ["Bob asked for a review", "overdue 7d, skipped 1 runs since 2026-10-24"],
			numbers: [
				["7d", "overdue"],
				["1", "count"],
				["2026-10-24", "date"],
			],
		});
	});

	it("saves a choice immediately, then advances to the next unanswered card", async () => {
		stubFetch();
		await mount();
		await click(card("a-1").querySelector<HTMLInputElement>("input[value=inbox]"));
		expect({
			calls: calls.slice(1),
			cards: shownCards(),
			position: text(".decisions-position"),
			progress: text(".decisions-progress"),
			lastSave: text(".decisions-last-save"),
		}).toStrictEqual({
			calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: "inbox", note: ""}}],
			cards: ["b-1"],
			position: ["Card 3 of 3"],
			progress: ["2 of 3 answered"],
			lastSave: ["Saved card 1"],
		});
	});

	it("submits and shows an All done page once the last unanswered card is saved", async () => {
		stubFetch();
		await mount();
		await click(card("a-1").querySelector<HTMLInputElement>("input[value=inbox]"));
		await click(card("b-1").querySelector<HTMLInputElement>("input[value=skip]"));
		expect({
			calls: calls.slice(1),
			cards: shownCards(),
			position: text(".decisions-position"),
			heading: text(".decisions-done h2"),
			done: text(".decisions-done p"),
			time: host?.querySelector(".decisions-done time")?.getAttribute("datetime"),
			review: button("Review answers").disabled,
		}).toStrictEqual({
			calls: [
				{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: "inbox", note: ""}},
				{method: "PUT", url: "/api/v1/decisions/meetings/b-1", body: {choice: "skip", note: ""}},
				{method: "POST", url: "/api/v1/decisions/meetings/submit", body: undefined},
			],
			cards: [],
			position: [],
			heading: ["All done"],
			done: [
				"All 3 cards answered.",
				`Submitted at ${submittedTime("2026-10-27T15:00:00.000Z")}. Tell Claude you're done.`,
			],
			time: "2026-10-27T15:00:00.000Z",
			review: false,
		});
	});

	it("shows the All done page on reload of a submitted page, and goes back to the cards to review", async () => {
		stubFetch(defaultWrite, {...pageAnswering(["a-1", "a-2", "b-1"]), submittedAt: "2026-10-27T15:00:00.000Z"});
		await mount();
		const loaded = {cards: shownCards(), heading: text(".decisions-done h2")};
		await click(button("Review answers"));
		expect({
			loaded,
			cards: shownCards(),
			heading: text(".decisions-done h2"),
			position: text(".decisions-position"),
		}).toStrictEqual({
			loaded: {cards: [], heading: ["All done"]},
			cards: ["a-1"],
			heading: [],
			position: ["Card 1 of 3"],
		});
	});

	it("shows the saved choice when going back from the All done page", async () => {
		stubFetch();
		await mount();
		await click(card("a-1").querySelector<HTMLInputElement>("input[value=inbox]"));
		await click(card("b-1").querySelector<HTMLInputElement>("input[value=skip]"));
		await click(button("Review answers"));
		expect({
			cards: shownCards(),
			radios: radios("a-1"),
			position: text(".decisions-position"),
		}).toStrictEqual({
			cards: ["a-1"],
			radios: [
				["inbox", true],
				["skip", false],
			],
			position: ["Card 1 of 3"],
		});
	});

	it("navigates with Back and Next, disabled at the ends", async () => {
		stubFetch();
		await mount();
		const atStart = {back: button("Back").disabled, next: button("Next").disabled};
		await click(button("Next"));
		const second = {cards: shownCards(), radios: radios("a-2"), position: text(".decisions-position")};
		await click(button("Next"));
		const atEnd = {cards: shownCards(), back: button("Back").disabled, next: button("Next").disabled};
		await click(button("Back"));
		expect({atStart, second, atEnd, cards: shownCards()}).toStrictEqual({
			atStart: {back: true, next: false},
			second: {cards: ["a-2"], radios: [["skip", true]], position: ["Card 2 of 3"]},
			atEnd: {cards: ["b-1"], back: false, next: true},
			cards: ["a-2"],
		});
	});

	it("offers a Light / Dark / System theme toggle that defaults to System and follows the OS", async () => {
		stubFetch();
		await mount();
		expect({
			labels: themeButtons().map((element) => [element.getAttribute("aria-label"), element.title]),
			pressed: pressedThemes(),
			icons: themeButtons().map((element) => element.querySelectorAll("svg").length),
			theme: document.documentElement.dataset.theme,
			stored: localStorage.getItem("workflowy-theme"),
		}).toStrictEqual({
			labels: [
				["Light theme", "Light"],
				["Dark theme", "Dark"],
				["System theme", "System"],
			],
			pressed: ["System theme"],
			icons: [1, 1, 1],
			theme: globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
			stored: null,
		});
	});

	it("forces dark and light and remembers the choice in the app's theme key", async () => {
		stubFetch();
		await mount();
		await click(themeButton("Dark theme"));
		const dark = {
			pressed: pressedThemes(),
			theme: document.documentElement.dataset.theme,
			stored: localStorage.getItem("workflowy-theme"),
		};
		await click(themeButton("Light theme"));
		expect({
			dark,
			light: {
				pressed: pressedThemes(),
				theme: document.documentElement.dataset.theme,
				stored: localStorage.getItem("workflowy-theme"),
			},
		}).toStrictEqual({
			dark: {pressed: ["Dark theme"], theme: "dark", stored: "dark"},
			light: {pressed: ["Light theme"], theme: "light", stored: "default"},
		});
	});

	it("still switches the theme when storage is blocked", async () => {
		stubFetch();
		await mount();
		const blockedWrites = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		await click(themeButton("Dark theme"));
		// restoreAllMocks does not reach happy-dom's localStorage proxy.
		blockedWrites.mockRestore();
		expect({pressed: pressedThemes(), theme: document.documentElement.dataset.theme}).toStrictEqual({
			pressed: ["Dark theme"],
			theme: "dark",
		});
	});

	it("restores the remembered theme on reload, and falls back to System when storage is unreadable", async () => {
		localStorage.setItem("workflowy-theme", "dark");
		vi.resetModules();
		const remembered = (await import("../src/client/stores/outline.js")).useOutlineStore.getState().theme;
		const rememberedDataTheme = document.documentElement.dataset.theme;
		const blockedReads = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
			throw new DOMException("blocked", "SecurityError");
		});
		vi.resetModules();
		const blocked = (await import("../src/client/stores/outline.js")).useOutlineStore.getState().theme;
		blockedReads.mockRestore();
		expect({remembered, rememberedDataTheme, blocked}).toStrictEqual({
			remembered: "dark",
			rememberedDataTheme: "dark",
			blocked: "system",
		});
	});

	it("answers with number keys and navigates with arrow keys, but not while typing a note", async () => {
		stubFetch();
		await mount();
		await key(document.body, "ArrowRight");
		const afterRight = shownCards();
		await key(document.body, "ArrowLeft");
		await key(card("a-1").querySelector("textarea")!, "2");
		const whileTyping = calls.length;
		await key(document.body, "2");
		expect({afterRight, whileTyping, calls: calls.slice(1), cards: shownCards()}).toStrictEqual({
			afterRight: ["a-2"],
			whileTyping: 1,
			calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: "skip", note: ""}}],
			cards: ["b-1"],
		});
	});

	it("debounces the note and saves it with the current choice without leaving the card", async () => {
		vi.useFakeTimers();
		stubFetch();
		await mount();
		await click(button("Next"));
		await typeNote(card("a-2").querySelector("textarea")!, ["l", "la", "later"]);
		expect(calls.slice(1)).toStrictEqual([]);
		await act(async () => {
			vi.advanceTimersByTime(700);
			await Promise.resolve();
		});
		await flush();
		expect({calls: calls.slice(1), cards: shownCards()}).toStrictEqual({
			calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-2", body: {choice: "skip", note: "later"}}],
			cards: ["a-2"],
		});
	});

	it("saves a note at once and advances with Save note & next", async () => {
		vi.useFakeTimers();
		stubFetch();
		await mount();
		await typeNote(card("a-1").querySelector("textarea")!, ["ask Bob"]);
		await click(button("Save note & next"));
		await act(async () => {
			vi.advanceTimersByTime(700);
			await Promise.resolve();
		});
		await flush();
		expect({calls: calls.slice(1), cards: shownCards(), progress: text(".decisions-progress")}).toStrictEqual({
			calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: null, note: "ask Bob"}}],
			cards: ["b-1"],
			progress: ["2 of 3 answered"],
		});
	});

	it("stays on the card and shows the server's error when a save fails", async () => {
		stubFetch(() => Response.json({error: 'Choice "inbox" is not an option for item "a-1"'}, {status: 400}));
		await mount();
		await click(card("a-1").querySelector<HTMLInputElement>("input[value=inbox]"));
		expect({cards: shownCards(), status: text(".decisions-status", card("a-1"))}).toStrictEqual({
			cards: ["a-1"],
			status: ['Not saved: Choice "inbox" is not an option for item "a-1"'],
		});
	});

	it("submits the page and confirms", async () => {
		stubFetch();
		await mount();
		await act(async () => {
			host?.querySelector<HTMLButtonElement>(".decisions-submit")?.click();
			await Promise.resolve();
		});
		await flush();
		expect({
			calls: calls.slice(1),
			confirmation: text(".decisions-submitted"),
		}).toStrictEqual({
			calls: [{method: "POST", url: "/api/v1/decisions/meetings/submit", body: undefined}],
			confirmation: ["Submitted. Tell Claude you're done."],
		});
	});

	it("shows why the page could not load", async () => {
		vi.stubGlobal("fetch", async () =>
			Promise.resolve(Response.json({error: "No decision page staged as meetings"}, {status: 404})),
		);
		await mount();
		expect(text(".decisions-error")).toStrictEqual(["No decision page staged as meetings"]);
	});
});
