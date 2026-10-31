// @vitest-environment happy-dom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {DEFAULT_FEATURES} from "../src/client/features.js";
import {featureKeys} from "../src/client/hooks/use-features.js";
import {EMPTY_PREFERENCES, preferenceKeys} from "../src/client/hooks/use-preferences.js";
import type {Preferences} from "../src/client/hooks/use-preferences.js";
import upstreamFeatures from "./fixtures/upstream-settings-features.json" with {type: "json"};

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const store = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
}));

vi.mock("../src/client/stores/outline.js", () => ({
	useOutlineStore: (selector: (state: Record<string, unknown>) => unknown) => selector(store.state),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {Settings} = await import("../src/client/components/settings.js");

/** Runs `change` inside act and lets React flush it. */
async function run(change: () => void): Promise<void> {
	await act(async () => {
		change();
		await Promise.resolve();
	});
}

let root: Root | undefined;
let host: HTMLElement | undefined;
const calls = {
	closeSettings: vi.fn<() => void>(),
	setTheme: vi.fn<(theme: string) => void>(),
	setShowKeyboardShortcuts: vi.fn<(on: boolean) => void>(),
	toggleRightBar: vi.fn<() => void>(),
	toggleRightBarCollapsed: vi.fn<() => void>(),
};
const fetchStub = vi.fn<typeof fetch>();
let featuresBody: unknown = {visible: [], enabled: {...DEFAULT_FEATURES}, available: true};

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
	vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	vi.stubGlobal("fetch", fetchStub);
	featuresBody = {visible: [], enabled: {...DEFAULT_FEATURES}, available: true};
	store.state = {
		settingsOpen: true,
		settingsSection: null,
		theme: "system",
		showKeyboardShortcuts: false,
		...calls,
	};
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const call of Object.values(calls)) {
		call.mockReset();
	}
	fetchStub.mockReset();
	await run(() => {
		root?.unmount();
	});
	host?.remove();
	vi.useRealTimers();
});

async function open(preferences: Partial<Preferences> = {}, opened: string | null = null): Promise<void> {
	fetchStub.mockImplementation(async (input, init) => {
		if (urlOf(input).startsWith("/api/v1/features")) {
			return Promise.resolve(Response.json(featuresBody));
		}
		const patch: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
		Object.assign(preferences, patch);
		return Promise.resolve(Response.json({...EMPTY_PREFERENCES, ...preferences}));
	});
	store.state.settingsSection = opened;
	const client = new QueryClient();
	client.setQueryData(preferenceKeys.all, {
		preferences: {...EMPTY_PREFERENCES, ...preferences},
		available: true,
		error: null,
	});
	client.setQueryData(featureKeys.all, featuresBody);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await run(() => {
		root?.render(createElement(QueryClientProvider, {client}, createElement(Settings)));
	});
}

/** The writes: a mounted dialog also re-reads preferences, which is not one. */
function patches() {
	return fetchStub.mock.calls.filter(([, init]) => init?.method === "PATCH");
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function collapse(value: string): string {
	return value.replaceAll(/\s+/gu, " ").trim();
}

function sectionTitles(): (string | undefined)[] {
	return [...document.querySelectorAll<HTMLElement>("[data-section-title]")].map((el) => el.dataset.sectionTitle);
}

function section(title: string): HTMLElement {
	const found = [...document.querySelectorAll<HTMLElement>("[data-section-title]")].find(
		(candidate) => candidate.dataset.sectionTitle === title,
	);
	if (!found) {
		throw new Error(`no section ${title}`);
	}
	return found;
}

function rowLabels(title: string): string[] {
	return [...section(title).querySelectorAll(".text-base.leading-s")].map((label) => label.textContent);
}

function toggleClasses(title: string): string[] {
	return [...section(title).querySelectorAll("label.toggle")].map((toggle) => collapse(toggle.className));
}

function jumpTrigger(): HTMLElement {
	const trigger = document.querySelector<HTMLElement>(".dialog-box .menu > div");
	if (!trigger) {
		throw new Error("no jump trigger");
	}
	return trigger;
}

async function pickOption(menu: HTMLElement, label: string): Promise<void> {
	await run(() => {
		menu.focus();
	});
	const row = [...document.querySelectorAll<HTMLElement>(".flyout a")].find(
		(candidate) => candidate.textContent === label,
	);
	await run(() => {
		row?.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
		row?.click();
	});
}

describe("Settings dialog", () => {
	it("renders the upstream dialog box, title, version and close button", async () => {
		await open();
		const box = document.querySelector<HTMLElement>(".dialog-box");
		expect({
			backdrop: document.querySelector(".dialog-backdrop")?.className,
			padded: box?.className.includes(" p-xl "),
			title: document.querySelector("h1")?.outerHTML,
			version: document.querySelector(".text-xs.space-x-2xs span")?.className,
			close: document.querySelector(".dialog-box svg.relative")?.outerHTML,
		}).toStrictEqual({
			backdrop:
				"fixed top-sat left-sal right-sar bottom-sab flex items-start justify-center print:hidden dialog-backdrop",
			padded: true,
			title: '<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl" style="margin-right: 0px;">Settings</h1>',
			version: "text-tertiary p-2xs cursor-pointer",
			close: '<svg class="relative" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke-linecap="round" stroke="var(--wf-text-tertiary)"><line x1="1" y1="1" x2="19" y2="19"></line><line x1="19" y1="1" x2="1" y2="19"></line></svg>',
		});
	});

	it("lists the sections in upstream order, skipping Account without a name and email and the empty Backup", async () => {
		await open();
		const without = sectionTitles();
		await run(() => {
			root?.unmount();
		});
		host?.remove();
		await open({account: {username: "Alice", email: "alice@example.com"}});
		expect({without, withAccount: sectionTitles(), accountLabels: rowLabels("Account")}).toStrictEqual({
			without: ["Personalization", "Dates", "Media & Previews", "Notifications", "Features"],
			withAccount: ["Account", "Personalization", "Dates", "Media & Previews", "Notifications", "Features"],
			accountLabels: ["Name", "Email"],
		});
	});

	it("offers Jump to for every registered section and labels it with the opened section", async () => {
		await open({}, "Dates");
		expect(jumpTrigger().textContent).toBe("Dates");
		await run(() => {
			document.querySelector<HTMLElement>(".dialog-box .menu")?.focus();
		});
		expect([...document.querySelectorAll(".flyout a")].map((row) => row.textContent)).toStrictEqual([
			"Jump to",
			"Personalization",
			"Dates",
			"Media & Previews",
			"Notifications",
			"Features",
		]);
	});

	it("leaves the Jump to label empty for a title no section has", async () => {
		await open({}, "Images");
		expect(jumpTrigger().textContent).toBe("");
	});

	it("centres and highlights the opened section 300ms after mount, but not for an unknown title", async () => {
		vi.useFakeTimers();
		const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
		await open({}, "Features");
		await run(() => {
			vi.advanceTimersByTime(299);
		});
		const early = section("Features").dataset.sectionHighlight;
		await run(() => {
			vi.advanceTimersByTime(1);
		});
		expect({early, late: section("Features").dataset.sectionHighlight, scroll: scroll.mock.calls}).toStrictEqual({
			early: undefined,
			late: "true",
			scroll: [[{block: "center", inline: "nearest"}]],
		});
		scroll.mockClear();
		await run(() => {
			root?.unmount();
		});
		host?.remove();
		await open({}, "Images");
		await run(() => {
			vi.advanceTimersByTime(400);
		});
		expect({
			highlighted: document.querySelectorAll("[data-section-highlight]").length,
			scroll: scroll.mock.calls,
		}).toStrictEqual({highlighted: 0, scroll: []});
	});

	it("scrolls a chosen section to the box top without highlighting it", async () => {
		await open();
		const box = document.querySelector<HTMLElement>(".dialog-box");
		if (!box) {
			throw new Error("no box");
		}
		Object.defineProperty(box, "clientTop", {value: 1});
		vi.spyOn(box, "getBoundingClientRect").mockReturnValue({top: 80} as DOMRect);
		vi.spyOn(section("Dates"), "getBoundingClientRect").mockReturnValue({top: 2000} as DOMRect);
		await pickOption(document.querySelector<HTMLElement>(".dialog-box .menu")!, "Dates");
		expect({
			scrollTop: box.scrollTop,
			highlighted: document.querySelectorAll("[data-section-highlight]").length,
			label: jumpTrigger().textContent,
		}).toStrictEqual({scrollTop: 1919, highlighted: 0, label: "Dates"});
	});

	it("closes on Escape without letting the key reach the window", async () => {
		await open();
		const reached = vi.fn<() => void>();
		window.addEventListener("keydown", reached);
		await run(() => {
			document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
		});
		window.removeEventListener("keydown", reached);
		expect({closed: calls.closeSettings.mock.calls, reached: reached.mock.calls}).toStrictEqual({
			closed: [[]],
			reached: [],
		});
	});

	it("shows the account theme in the Personalization dropdown and saves a new choice to the account and the app", async () => {
		await open({theme: "dark"});
		const menu = section("Personalization").querySelector<HTMLElement>(".menu");
		const label = menu?.firstElementChild?.textContent;
		await run(() => {
			menu?.focus();
		});
		const options = [...document.querySelectorAll(".flyout a")].map((row) => row.textContent);
		await pickOption(menu!, "System");
		expect({
			label,
			options,
			patch: patches().map(([, init]) => [init?.method, init?.body]),
			setTheme: calls.setTheme.mock.calls,
		}).toStrictEqual({
			label: "Dark",
			options: [
				"Light",
				"Dark",
				"System",
				"Vintage",
				"Catppuccin",
				"Chocolate",
				"Glass",
				"Hacker",
				"Matcha",
				"Moon",
				"Neo",
				"Robot",
				"Space",
				"Steel",
				"Wood",
				"One Dark",
			],
			patch: [["PATCH", '{"theme":"system"}']],
			setTheme: [["system"]],
		});
	});

	it("saves a non-standard theme such as Space to the account and the app", async () => {
		await open({theme: "dark"});
		await pickOption(section("Personalization").querySelector<HTMLElement>(".menu")!, "Space");
		expect({
			patch: patches().map(([, init]) => init?.body),
			setTheme: calls.setTheme.mock.calls,
		}).toStrictEqual({patch: ['{"theme":"space"}'], setTheme: [["space"]]});
	});

	it("labels the dropdown with the account's theme name", async () => {
		await open({theme: "one_dark"});
		const menu = section("Personalization").querySelector<HTMLElement>(".menu");
		expect(menu?.firstElementChild?.textContent).toBe("One Dark");
	});

	it("maps Light to the account's default theme", async () => {
		await open({theme: "dark"});
		await pickOption(section("Personalization").querySelector<HTMLElement>(".menu")!, "Light");
		expect({
			patch: patches().map(([, init]) => init?.body),
			setTheme: calls.setTheme.mock.calls,
		}).toStrictEqual({patch: ['{"theme":"default"}'], setTheme: [["default"]]});
	});

	it("shows the account emoji style in the Emojis dropdown and saves a choice to the account, the body and this browser", async () => {
		localStorage.clear();
		await open({emojiSelected: "system"});
		const menu = [...section("Personalization").querySelectorAll<HTMLElement>(".menu")].at(1);
		const label = menu?.firstElementChild?.textContent;
		await run(() => {
			menu?.focus();
		});
		const options = [...document.querySelectorAll(".flyout a")].map((row) => row.textContent);
		await pickOption(menu!, "Noto Emoji");
		expect({
			rows: rowLabels("Personalization"),
			label,
			options,
			patch: patches().map(([, init]) => init?.body),
			bodyClass: document.body.classList.contains("emoji-noto"),
			stored: localStorage.getItem("emoji_options__selected"),
		}).toStrictEqual({
			rows: ["Theme", "Emojis"],
			label: "System",
			options: ["System", "Noto Emoji"],
			patch: ['{"emojiSelected":"noto"}'],
			bodyClass: true,
			stored: "noto",
		});
	});

	it("labels the Emojis dropdown System when the account has no emoji style", async () => {
		localStorage.clear();
		await open();
		const menu = [...section("Personalization").querySelectorAll<HTMLElement>(".menu")].at(1);
		expect(menu?.firstElementChild?.textContent).toBe("System");
	});

	it("shows the media rows from the account flags and writes an embed toggle inverted", async () => {
		await open();
		const thumbnails =
			section("Media & Previews").querySelector<HTMLElement>(".menu")?.firstElementChild?.textContent;
		const defaults = toggleClasses("Media & Previews").map((value) => value.split(" ")[1]);
		await run(() => {
			section("Media & Previews").querySelectorAll<HTMLElement>("label.toggle")[3]?.click();
		});
		expect({
			labels: rowLabels("Media & Previews"),
			thumbnails,
			defaults,
			patch: patches().map(([, init]) => init?.body),
		}).toStrictEqual({
			labels: [
				"Image thumbnails size",
				"Embed YouTube videos",
				"Embed YouTube Shorts",
				"Embed Tweets",
				"Embed Loom",
			],
			thumbnails: "Big",
			defaults: ["on", "on", "on", "on"],
			patch: ['{"ignoreLoom":true}'],
		});
	});

	it("shows an ignored embed as off and small thumbnails as Small", async () => {
		await open({ignoreLoom: true, displayImagePreviewsAsThumbnails: true});
		expect({
			last: toggleClasses("Media & Previews").at(-1)?.split(" ")[1],
			thumbnails: section("Media & Previews").querySelector<HTMLElement>(".menu")?.firstElementChild?.textContent,
		}).toStrictEqual({last: "off", thumbnails: "Small"});
	});

	it("lists the weekly report and daily summary toggles, the latter inverted, and writes them", async () => {
		await open({unsubscribeFromSummaryEmails: true});
		const states = toggleClasses("Notifications").map((value) => value.split(" ")[1]);
		const toggles = section("Notifications").querySelectorAll<HTMLElement>("label.toggle");
		await run(() => {
			toggles[0]?.click();
		});
		await run(() => {
			toggles[1]?.click();
		});
		expect({
			labels: rowLabels("Notifications"),
			states,
			patch: patches().map(([, init]) => init?.body),
		}).toStrictEqual({
			labels: ["Show weekly report", "Daily change email summary"],
			states: ["off", "off"],
			patch: ['{"weeklyReportOn":true}', '{"unsubscribeFromSummaryEmails":false}'],
		});
	});

	it("keeps the Dates section by default and drops it when the dates flag is off", async () => {
		await open();
		const defaults = sectionTitles();
		await run(() => {
			root?.unmount();
		});
		host?.remove();
		featuresBody = {
			visible: [],
			enabled: Object.fromEntries(Object.entries(DEFAULT_FEATURES).filter(([name]) => name !== "dates")),
			available: true,
		};
		await open();
		expect({defaults, off: sectionTitles()}).toStrictEqual({
			defaults: ["Personalization", "Dates", "Media & Previews", "Notifications", "Features"],
			off: ["Personalization", "Media & Previews", "Notifications", "Features"],
		});
	});

	it("has a Keyboard shortcuts helper toggle that sets the preference and leaves the right bar alone", async () => {
		await open();
		const toggle = section("Features").querySelector<HTMLElement>("label.toggle");
		const classes = collapse(toggle?.className ?? "");
		await run(() => {
			toggle?.click();
		});
		expect({
			labels: rowLabels("Features"),
			classes,
			set: calls.setShowKeyboardShortcuts.mock.calls,
			bar: [calls.toggleRightBar.mock.calls, calls.toggleRightBarCollapsed.mock.calls],
		}).toStrictEqual({
			labels: ["Keyboard shortcuts helper"],
			classes: "toggle off inline-flex gap-m mobile:gap-l showKeyboardShortcuts cursor-pointer",
			set: [[true]],
			bar: [[], []],
		});
	});

	it("lists one toggle per server feature in server order, with LABS badges, hints and upstream's toggle classes", async () => {
		const {visible, enabled} = upstreamFeatures;
		featuresBody = {visible, enabled, available: true};
		await open();
		const features = section("Features");
		const badges = [...features.querySelectorAll<HTMLElement>(".text-base.leading-s > div")].map((badge) => [
			badge.parentElement?.firstChild?.textContent,
			badge.textContent,
			badge.getAttribute("style"),
		]);
		const LABS = "color: var(--wf-gray-0); background: var(--wf-blue-300);";

		expect({
			labels: [...features.querySelectorAll(".text-base.leading-s")].map(
				(label) => label.firstChild?.textContent,
			),
			states: [...features.querySelectorAll("label.toggle")].map((toggle) =>
				toggle.classList.contains("on") ? "on" : "off",
			),
			badges,
			datesClass: features.querySelector("label.toggle.dates")?.className,
			hints: features.querySelectorAll(".text-s.leading-xs").length,
			firstHint: features.querySelector(".text-s.leading-xs")?.textContent,
		}).toStrictEqual({
			labels: [
				"Keyboard shortcuts helper",
				"Workflowy Labs",
				"Open links in desktop app",
				"Dates",
				"Full width page",
				"Templates",
				"Backlinks",
				"Keep Mobile Keyboard on Scroll",
				"Rich tags",
				"Always show expand/collapse arrows",
				"All updates",
				"Fractal Comments",
				"Dashboard layout",
				"Workflowy AI",
				"Instant Presentations",
				"Nested search",
				"Recognize markdown pasting",
				"Calendar",
				"Numbered List",
				"Tables",
				"Panes",
			],
			states: [
				"off",
				...Array.from({length: 10}, () => "on"),
				"off",
				"off",
				"off",
				...Array.from({length: 7}, () => "on"),
			],
			badges: [
				["All updates", "LABS", LABS],
				["Dashboard layout", "LABS", LABS],
				["Workflowy AI", "LABS", LABS],
				["Instant Presentations", "LABS", LABS],
			],
			datesClass: "toggle on inline-flex gap-m mobile:gap-l\n        dates\n        cursor-pointer",
			hints: 20,
			firstHint: visible[0]?.description,
		});
	});

	it("posts the feature POST for a clicked server toggle and flips it at once", async () => {
		featuresBody = {visible: upstreamFeatures.visible, enabled: {dates: true}, available: true};
		await open();
		const dashboards = section("Features").querySelector<HTMLElement>("label.toggle.dashboards");

		await run(() => {
			dashboards?.click();
		});

		const posts = fetchStub.mock.calls.filter(([input]) => urlOf(input).startsWith("/api/v1/features/"));
		expect(posts.map(([input, init]) => [urlOf(input), init?.method, init?.body])).toStrictEqual([
			["/api/v1/features/dashboards", "POST", '{"on":true}'],
		]);
	});

	it("copies the version and flashes copied! for 2000ms", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
		await open();
		await run(() => {
			document.querySelector<HTMLElement>(".text-xs.space-x-2xs")?.click();
		});
		const flashing = document.querySelector(".text-success")?.textContent;
		await run(() => {
			vi.advanceTimersByTime(2000);
		});
		expect({
			flashing,
			after: document.querySelector(".text-success"),
			copied: writeText.mock.calls.length,
		}).toStrictEqual({flashing: "copied!", after: null, copied: 1});
	});
});
