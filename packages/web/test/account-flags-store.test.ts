import {afterEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {featureStoreState, setFeatureWriter} = await import("../src/client/features.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

describe("account flags in the outline store", () =>
{
	afterEach(() =>
	{
		setFeatureWriter(async () => Promise.resolve());
	});

	it("derives fullWidthPage and alwaysVisibleControls from the enabled dict", () =>
	{
		expect([
			featureStoreState({}),
			featureStoreState(
				{
					full_width_page: true,
					always_visible_controls: true,
				},
			),
		]).toStrictEqual([
			{
				fullWidthPage: false,
				alwaysVisibleControls: false,
			},
			{
				fullWidthPage: true,
				alwaysVisibleControls: true,
			},
		]);
	});

	it("toggle_full_width_page writes the account flag once and flips the store", () =>
	{
		const writes: [string, boolean][] = [];
		setFeatureWriter(async (codename, on) =>
		{
			writes.push([codename, on]);
			return Promise.resolve();
		});
		useOutlineStore.setState(
			{
				fullWidthPage: true,
			},
		);

		useOutlineStore.getState().toggleFullWidthPage();

		expect(writes).toStrictEqual([["full_width_page", false]]);
		expect(useOutlineStore.getState().fullWidthPage).toBe(false);
	});

	it("restores the store when the write fails", async () =>
	{
		setFeatureWriter(async () => Promise.reject(new Error("500")));
		useOutlineStore.setState(
			{
				fullWidthPage: true,
			},
		);

		useOutlineStore.getState().toggleFullWidthPage();
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 0);
		});

		expect(useOutlineStore.getState().fullWidthPage).toBe(true);
	});
});
