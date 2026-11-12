import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {isFeatureOn, setAccountFeatures} from "../src/client/features.js";
import {featureKeys, setFeature} from "../src/client/hooks/use-features.js";
import type {FeaturesResponse} from "../src/node-types.js";

const START: FeaturesResponse =
{
	visible: [],
	enabled:
	{
		dates: true,
	},
	available: true,
};

function clientWithStart()
{
	const client = new QueryClient();
	client.setQueryData(featureKeys.all, START);
	return client;
}

describe("setFeature", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
		setAccountFeatures(null);
	});

	it("flips the dict at once, then stores the server's dict", async () =>
	{
		const seen: unknown[] = [];
		const client = clientWithStart();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
			{
				seen.push(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled);
				return Promise.resolve(
					Response.json(
						{
							enabled:
							{
								dates: true,
								dashboards: true,
							},
						},
					),
				);
			}),
		);

		await setFeature(client, "dashboards", true);

		expect(seen).toStrictEqual([
			{
				dates: true,
				dashboards: true,
			},
		]);
		expect(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled).toStrictEqual(
			{
				dates: true,
				dashboards: true,
			},
		);
		expect(isFeatureOn("dashboards")).toBe(true);
	});

	it("drops the key when disabling", async () =>
	{
		const client = clientWithStart();
		const fetchStub = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json(
					{
						enabled: {},
					},
				),
			),
		);
		vi.stubGlobal("fetch", fetchStub);

		await setFeature(client, "dates", false);

		expect(fetchStub.mock.calls).toStrictEqual([
			[
				"/api/v1/features/dates",
				{
					method: "POST",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: '{"on":false}',
				},
			],
		]);
		expect(client.getQueryData<FeaturesResponse>(featureKeys.all)?.enabled).toStrictEqual({});
	});

	it("restores the previous dict when the POST fails", async () =>
	{
		const client = clientWithStart();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Promise.resolve(
					new Response(
						"boom",
						{
							status: 500,
						},
					),
				),
			),
		);

		await expect(setFeature(client, "dashboards", true)).rejects.toThrow("500");

		expect(client.getQueryData<FeaturesResponse>(featureKeys.all)).toStrictEqual(START);
		expect(isFeatureOn("dashboards")).toBe(false);
	});
});
