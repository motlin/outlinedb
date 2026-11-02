import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vite-plus/test";
import {EMPTY_PREFERENCES, preferenceKeys} from "../src/client/hooks/use-preferences.js";
import type {PreferencesState} from "../src/client/hooks/use-preferences.js";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (state: object) => unknown) => selector({}),
}));

const {DatesSection} = await import("../src/client/components/settings.js");

const NOW = new Date(2026, 9, 1, 14, 40);
const LEARN_MORE = "https://momentjscom.readthedocs.io/en/latest/moment/04-displaying/01-format/";

function render(state: PreferencesState): string
{
	const client = new QueryClient();
	client.setQueryData(preferenceKeys.all, state);
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client,
			},
			createElement(
				DatesSection,
				{
					now: NOW,
				},
			),
		),
	);
}

/** The parts of the Dates section the user sees and acts on. */
function summarize(html: string)
{
	return {
		labels: [...html.matchAll(/<label class="settings-label"[^>]*>([^<]*)<\/label>/gu)].map((m) => m[1]),
		selected: [...html.matchAll(/<option value="([^"]*)" selected="">([^<]*)<\/option>/gu)].map((m) => [
			m[1],
			m[2],
		]),
		inputs: [...html.matchAll(/<input [^>]*class="settings-input (w-\[\d+px\])"[^>]*value="([^"]*)"/gu)].map(
			(m) => [m[1], m[2]],
		),
		disabled: [...html.matchAll(/ disabled=""/gu)].length,
		info: [...html.matchAll(/<span class="settings-info">([^<]*)<\/span>/gu)].map((m) => m[1]),
		learnMore: /<a href="([^"]*)"[^>]*>Learn more<\/a>/u.exec(html)?.[1],
	};
}

describe("Settings > Dates", () =>
{
	it("shows the account's formats, including a custom date format", () =>
	{
		const html = render(
			{
				preferences:
				{
					...EMPTY_PREFERENCES,
					dateFormat: "YYYY-MM-DD ddd",
					timeFormat: "HH:mm",
					weekStartDay: 1,
				},
				available: true,
				error: null,
			},
		);
		expect(summarize(html)).toStrictEqual(
			{
				labels: ["Date format", "Time format", "Start of week", "Custom date format"],
				selected: [
					["YYYY-MM-DD ddd", "2026-10-01 Thu"],
					["HH:mm", "14:40"],
					["1", "Monday"],
				],
				inputs: [
					["w-[200px]", "YYYY-MM-DD ddd"],
					["w-[120px]", "HH:mm"],
				],
				disabled: 0,
				info: [],
				learnMore: LEARN_MORE,
			},
		);
	});

	it("selects upstream defaults when nothing is stored", () =>
	{
		const html = render(
			{
				preferences: EMPTY_PREFERENCES,
				available: true,
				error: null,
			},
		);
		expect(summarize(html).selected).toStrictEqual([
			["ddd, MMM D", "Thu, Oct 1"],
			["h:mma", "2:40pm"],
			["0", "Sunday"],
		]);
	});

	it("disables every row with the endpoint's error when preferences are unavailable", () =>
	{
		const html = render(
			{
				preferences: EMPTY_PREFERENCES,
				available: false,
				error: "Internal API is not configured",
			},
		);
		const {disabled, info} = summarize(html);
		expect(
			{
				disabled,
				info,
			},
		).toStrictEqual(
			{
				disabled: 5,
				info: ["Internal API is not configured"],
			},
		);
	});
});
