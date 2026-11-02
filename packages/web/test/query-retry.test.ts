import {MutationObserver, QueryClient, focusManager} from "@tanstack/react-query";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {queryClientDefaults, shouldRetry} from "../src/client/query-retry.js";
import {RequestStatusError} from "../src/client/request-error.js";

afterEach(() =>
{
	focusManager.setFocused(undefined);
});

describe("shouldRetry", () =>
{
	it("classifies by status, not by message digits", () =>
	{
		expect([
			shouldRetry(0, new RequestStatusError(400, "x: Bad Request")),
			shouldRetry(0, new RequestStatusError(404, "x")),
			shouldRetry(0, new RequestStatusError(503, "x")),
			shouldRetry(0, new RequestStatusError(429, "x")),
			shouldRetry(0, new TypeError("fetch failed")),
			shouldRetry(3, new TypeError("fetch failed")),
		]).toStrictEqual([false, false, true, true, true, false]);
	});
});

describe("mutation defaults", () =>
{
	it("settles a failed mutation once, even in a hidden tab", async () =>
	{
		focusManager.setFocused(false);
		const client = new QueryClient(
			{
				defaultOptions: queryClientDefaults,
			},
		);
		let calls = 0;
		const observer = new MutationObserver(
			client,
			{
				mutationFn: async () =>
				{
					calls += 1;
					return Promise.reject(new RequestStatusError(400, "x"));
				},
			},
		);
		await observer.mutate().catch(() => {});
		expect(
			{
				calls,
				isMutating: client.isMutating(),
			},
		).toStrictEqual(
			{
				calls: 1,
				isMutating: 0,
			},
		);
	});
});
