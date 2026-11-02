// @vitest-environment happy-dom
import {QueryClient, QueryObserver} from "@tanstack/react-query";
import {afterEach, expect, it, vi} from "vite-plus/test";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() =>
{
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("polls the expansion change feed every 15s after the page load through a TanStack Query refetch interval", async () =>
{
	vi.stubGlobal("fetch", fetchMock);
	const {expansionPollQuery, EXPANSION_POLL_MS, loadExpansion} =
		await import("../src/client/hooks/use-expansion-sync.js");
	fetchMock.mockImplementation(async () =>
		Promise.resolve(
			Response.json(
				{
					version: "aaaaaaaaaaaaaaaa",
					expandedIds: ["a"],
				},
			),
		),
	);
	await loadExpansion();
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () =>
		Promise.resolve(
			Response.json(
				{
					version: "aaaaaaaaaaaaaaaa",
					expandedIds: null,
				},
			),
		),
	);
	vi.useFakeTimers();
	const queryClient = new QueryClient();

	const unsubscribe = new QueryObserver(queryClient, expansionPollQuery).subscribe(() => {});
	await vi.advanceTimersByTimeAsync(EXPANSION_POLL_MS * 2);
	unsubscribe();
	queryClient.clear();

	expect(
		{
			period: EXPANSION_POLL_MS,
			urls: fetchMock.mock.calls.map(([url]) => url),
		},
	).toStrictEqual(
		{
			period: 15_000,
			urls: [
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
				"/api/v1/expansion?version=aaaaaaaaaaaaaaaa",
			],
		},
	);
});
