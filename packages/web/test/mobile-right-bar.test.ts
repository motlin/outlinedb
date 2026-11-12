// @vitest-environment happy-dom
import type * as IsMobileModule from "../src/client/is-mobile.js";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";

const device = vi.hoisted(() => (
{
	mobile: true,
}));
vi.mock("../src/client/is-mobile.js", async (importOriginal) =>
{
	const original = await importOriginal<typeof IsMobileModule>();
	return {
		...original,
		get IS_MOBILE()
		{
			return device.mobile;
		},
	};
});

const {createElement} = await import("react");
const {renderToStaticMarkup} = await import("react-dom/server");
const {RightBar} = await import("../src/client/components/right-bar.js");
const {mobileSearchVisible} = await import("../src/client/mobile-search-model.js");

afterEach(() =>
{
	device.mobile = true;
});

describe("RightBar on a phone", () =>
{
	it("renders nothing", () =>
	{
		expect(renderToStaticMarkup(createElement(RightBar))).toBe("");
	});

	it("still renders on desktop", () =>
	{
		device.mobile = false;
		expect(renderToStaticMarkup(createElement(RightBar))).toContain("right-bar");
	});
});

describe("mobileSearchVisible", () =>
{
	it("shows the form while focused or holding a query", () =>
	{
		expect([
			mobileSearchVisible(
				{
					focused: false,
					input: "",
					query: "",
				},
			),
			mobileSearchVisible(
				{
					focused: true,
					input: "",
					query: "",
				},
			),
			mobileSearchVisible(
				{
					focused: false,
					input: "a",
					query: "",
				},
			),
			mobileSearchVisible(
				{
					focused: false,
					input: "",
					query: "a",
				},
			),
		]).toStrictEqual([false, true, true, true]);
	});
});
