// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {editableText} from "../src/client/components/editable-text.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Promise.resolve(Response.json({}))),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

/** The query keys mounting one row name puts in the cache. */
function mountedQueryKeys(isEditing: boolean): string[]
{
	const queryClient = new QueryClient();
	root = createRoot(document.createElement("div"));
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue: "Alice",
						parentId: null,
						priority: 0,
						isEditing,
					},
				),
			),
		);
	});
	return queryClient
		.getQueryCache()
		.getAll()
		.map((query) => String(query.queryKey[0]));
}

describe("EditableText at rest", () =>
{
	it("mounts a resting row with only the date settings and account it renders pills with, leaving the editor's queries to the edited row", () =>
	{
		const resting = mountedQueryKeys(false);
		act(() =>
		{
			root?.unmount();
		});
		expect(
			{
				resting,
				editing: mountedQueryKeys(true),
			},
		).toStrictEqual(
			{
				resting: ["preferences", "account"],
				editing: [
					"preferences",
					"account",
					"tag-autocomplete",
					"calendar-days",
					"calendar-days",
					"calendar-days",
				],
			},
		);
	});
});

const TIMED_PILL =
	'<time startYear="2026" startMonth="10" startDay="2" startHour="14" startMinute="30">Fri, Oct 2, 2026 at 2:30pm</time>';

/** Mounts a resting row, clicks its pill, then runs `act` on the open picker; returns the saved name and the store's edit state. */
async function pickOnRestingPill(
	initialValue: string,
	choose: () => void,
): Promise<
{
	names: string[];
	editingId: string | null;
	caret: number | null;
}>
{
	const names: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) =>
		{
			if (typeof init?.body === "string")
			{
				const body: unknown = JSON.parse(init.body);
				if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string")
				{
					names.push(body.name);
				}
			}
			return Promise.resolve(
				Response.json(
					{
						days: [],
					},
				),
			);
		}),
	);
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue,
						parentId: null,
						priority: 0,
						isEditing: false,
					},
				),
			),
		);
		await Promise.resolve();
	});
	await act(async () =>
	{
		host.querySelector("time")?.dispatchEvent(
			new MouseEvent(
				"click",
				{
					bubbles: true,
					cancelable: true,
				},
			),
		);
		await Promise.resolve();
	});
	await act(async () =>
	{
		choose();
		await Promise.resolve();
	});
	const {editingId, editingCaretOffset} = useOutlineStore.getState();
	return {
		names,
		editingId,
		caret: editingCaretOffset,
	};
}

describe("EditableText resting pill picker", () =>
{
	it("applying a day replaces the pill, drops the hours and edits the row with the caret after the pill", async () =>
	{
		const result = await pickOnRestingPill(`dpHours ${TIMED_PILL}`, () =>
		{
			const five = [...document.querySelectorAll<HTMLElement>('[data-date-picker-day-button="true"]')].find(
				(button) => button.textContent === "5",
			);
			five?.click();
		});
		expect(result).toStrictEqual(
			{
				names: ['dpHours <time startYear="2026" startMonth="10" startDay="5">Mon, Oct 5, 2026</time>'],
				editingId: "alice",
				caret: 9,
			},
		);
	});

	it("Remove date edits the row with the caret where the pill was", async () =>
	{
		const result = await pickOnRestingPill(`dpOtherYear ${TIMED_PILL}`, () =>
		{
			const remove = [...document.querySelectorAll<HTMLElement>(".menuItem")].find(
				(row) => row.textContent === "Remove date",
			);
			remove?.click();
		});
		expect(result).toStrictEqual(
			{
				names: ["dpOtherYear "],
				editingId: "alice",
				caret: 12,
			},
		);
	});
});
