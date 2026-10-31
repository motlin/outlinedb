import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {markWhatsNewRead, whatsNewKeys, whatsNewUnreadFrom} from "../src/client/hooks/use-whats-new.js";
import type {WhatsNewState} from "../src/client/hooks/use-whats-new.js";

function whatsNewClient(state: WhatsNewState | undefined): QueryClient {
	const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
	if (state !== undefined) {
		queryClient.setQueryData(whatsNewKeys.all, state);
	}
	return queryClient;
}

function stubFetch(): {url: string; method: string; body: unknown}[] {
	const requests: {url: string; method: string; body: unknown}[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		requests.push({url, method: init?.method ?? "GET", body: JSON.parse(init?.body as string) as unknown});
		return Promise.resolve(Response.json({read: ["as_of_queries", "older_entry"]}));
	});
	return requests;
}

describe("whatsNewUnreadFrom", () => {
	it("is false while loading, and true while one of our entries is not read", () => {
		expect({
			loading: whatsNewUnreadFrom(undefined),
			neverRead: whatsNewUnreadFrom({read: []}),
			allRead: whatsNewUnreadFrom({read: ["as_of_queries"]}),
		}).toStrictEqual({loading: false, neverRead: true, allRead: false});
	});
});

describe("markWhatsNewRead", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs the unread entries to our own endpoint, never upstream's preferences, and stores the answer", async () => {
		const requests = stubFetch();
		const queryClient = whatsNewClient({read: ["older_entry"]});
		await markWhatsNewRead(queryClient);
		expect({requests, cached: queryClient.getQueryData<WhatsNewState>(whatsNewKeys.all)}).toStrictEqual({
			requests: [{url: "/api/v1/whats-new/read", method: "POST", body: {entries: ["as_of_queries"]}}],
			cached: {read: ["as_of_queries", "older_entry"]},
		});
	});

	it("issues no request when every entry is read or while loading", async () => {
		const requests = stubFetch();
		await markWhatsNewRead(whatsNewClient({read: ["as_of_queries"]}));
		await markWhatsNewRead(whatsNewClient(undefined));
		expect(requests).toStrictEqual([]);
	});
});
