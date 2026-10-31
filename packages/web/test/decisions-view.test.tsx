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
					links: [{label: "Meeting", href: "https://example.com/meeting"}],
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
					body: ["Bob asked for a review"],
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
	await act(async () => {
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	calls = [];
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
			legends: host?.querySelectorAll("legend").length,
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
			]),
			radios: radios("a-1"),
			optionLabels: text(".decisions-option-label", first),
			optionKeys: text(".decisions-option-key", first),
			optionDescriptions: text(".decisions-option-description", first),
			suggested: text(".decisions-suggested", first),
			position: text(".decisions-position"),
			progress: text(".decisions-progress"),
			jump: text(".decisions-jump button"),
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
			links: [["Meeting", "https://example.com/meeting", "_blank", "noopener noreferrer"]],
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
			jump: ["1", "3"],
			allAnswered: [],
			calls: [{method: "GET", url: "/api/v1/decisions/meetings", body: undefined}],
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
			jump: text(".decisions-jump button"),
		}).toStrictEqual({
			cards: ["b-1"],
			heading: ["Standup - Tue Oct 27"],
			headingLinks: 0,
			position: ["Card 3 of 3"],
			jump: ["3"],
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
			jump: text(".decisions-jump button"),
			lastSave: text(".decisions-last-save"),
		}).toStrictEqual({
			calls: [{method: "PUT", url: "/api/v1/decisions/meetings/a-1", body: {choice: "inbox", note: ""}}],
			cards: ["b-1"],
			position: ["Card 3 of 3"],
			progress: ["2 of 3 answered"],
			jump: ["3"],
			lastSave: ["Saved card 1"],
		});
	});

	it("shows the saved choice when going back, and says when every card is answered", async () => {
		stubFetch();
		await mount();
		await click(card("a-1").querySelector<HTMLInputElement>("input[value=inbox]"));
		await click(card("b-1").querySelector<HTMLInputElement>("input[value=skip]"));
		const afterLast = {
			cards: shownCards(),
			allAnswered: text(".decisions-all-answered"),
			jump: text(".decisions-jump button"),
		};
		await click(button("Back"));
		await click(button("Back"));
		expect({
			afterLast,
			cards: shownCards(),
			radios: radios("a-1"),
			position: text(".decisions-position"),
		}).toStrictEqual({
			afterLast: {cards: ["b-1"], allAnswered: ["All 3 answered. Submit when ready."], jump: []},
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

	it("jumps straight to an unanswered card", async () => {
		stubFetch();
		await mount();
		await click([...(host?.querySelectorAll<HTMLButtonElement>(".decisions-jump button") ?? [])][1]);
		expect({cards: shownCards(), current: text(".decisions-jump [aria-current=true]")}).toStrictEqual({
			cards: ["b-1"],
			current: ["3"],
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
