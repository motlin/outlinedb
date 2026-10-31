// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {CalendarTodayControl} = await import("../src/client/components/calendar-today-control.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await act(async () => {
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		});
	}
}

interface Mounted {
	requests: {method: string; body: unknown}[];
	todays: number[];
}

/** Mount the control over a preferences endpoint answering `calendarTooltipSeen` (503 when null). */
async function mount(calendarTooltipSeen: boolean | null): Promise<Mounted> {
	const mounted: Mounted = {requests: [], todays: []};
	let seen = calendarTooltipSeen;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			mounted.requests.push({method: init?.method ?? "GET", body: init?.body});
			if (seen === null) {
				return Promise.resolve(Response.json({error: "not configured"}, {status: 503}));
			}
			if (init?.method === "PATCH") {
				seen = (JSON.parse(init.body as string) as {calendarTooltipSeen: boolean}).calendarTooltipSeen;
			}
			return Promise.resolve(Response.json({...EMPTY_PREFERENCES, calendarTooltipSeen: seen}));
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	await act(async () => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client: queryClient},
				<CalendarTodayControl
					onToday={() => {
						mounted.todays.push(1);
					}}
				>
					<div id="plain-today">Today</div>
				</CalendarTodayControl>,
			),
		);
		await Promise.resolve();
	});
	await settle();
	return mounted;
}

/** What the control shows: the plain Today, the onboarding trigger, and the tooltip's text. */
function shown(): {plainToday: boolean; onboarding: boolean; tooltip: string | null} {
	return {
		plainToday: host!.querySelector("#plain-today") !== null,
		onboarding: host!.querySelector(".shape-circle.iconButton.lg") !== null,
		tooltip: document.body.querySelector("[data-calendar-tooltip]")?.textContent ?? null,
	};
}

const TOOLTIP_TEXT =
	"NewCalendarA daily hub for planning, notes, and reflection, so you can stay calm, clear, and in control.Try it out";

async function click(element: Element | null | undefined): Promise<void> {
	await act(async () => {
		(element as HTMLElement | null)?.click();
		await Promise.resolve();
	});
	await settle();
}

describe("CalendarTodayControl", () => {
	it("shows the plain Today once calendar.tooltip_seen is true", async () => {
		await mount(true);

		expect(shown()).toStrictEqual({plainToday: true, onboarding: false, tooltip: null});
	});

	it("shows the plain Today when the internal API is unavailable", async () => {
		await mount(null);

		expect(shown()).toStrictEqual({plainToday: true, onboarding: false, tooltip: null});
	});

	it("shows the onboarding button and its open tooltip instead of Today until the tooltip is seen", async () => {
		await mount(false);

		expect(shown()).toStrictEqual({plainToday: false, onboarding: true, tooltip: TOOLTIP_TEXT});
	});

	it("marks the tooltip seen and navigates to today on Try it out", async () => {
		const mounted = await mount(false);

		const tryIt = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Try it out");
		await click(tryIt);

		expect({shown: shown(), requests: mounted.requests, todays: mounted.todays}).toStrictEqual({
			shown: {plainToday: true, onboarding: false, tooltip: null},
			requests: [
				{method: "GET", body: undefined},
				{method: "PATCH", body: '{"calendarTooltipSeen":true}'},
			],
			todays: [1],
		});
	});

	it("marks the tooltip seen and navigates to today on the onboarding button", async () => {
		const mounted = await mount(false);

		await click(host!.querySelector(".shape-circle.iconButton.lg"));

		expect({
			shown: shown(),
			patches: mounted.requests.filter((r) => r.method === "PATCH"),
			todays: mounted.todays,
		}).toStrictEqual({
			shown: {plainToday: true, onboarding: false, tooltip: null},
			patches: [{method: "PATCH", body: '{"calendarTooltipSeen":true}'}],
			todays: [1],
		});
	});

	it("marks the tooltip seen without navigating on close", async () => {
		const mounted = await mount(false);

		await click(document.body.querySelector(".close-tooltip"));

		expect({
			shown: shown(),
			patches: mounted.requests.filter((r) => r.method === "PATCH"),
			todays: mounted.todays,
		}).toStrictEqual({
			shown: {plainToday: true, onboarding: false, tooltip: null},
			patches: [{method: "PATCH", body: '{"calendarTooltipSeen":true}'}],
			todays: [],
		});
	});
});
