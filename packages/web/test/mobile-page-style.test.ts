import {describe, expect, it} from "vite-plus/test";
import {mobilePagePadding, pageClassName, pageContainerClassName, pageStyle} from "../src/client/page-style.js";

const NO_INSETS =
{
	left: 0,
	right: 0,
};

describe("mobilePagePadding", () =>
{
	it("uses upstream's ln2 mobile branch: 16/24 below 720px and 40/40 above", () =>
	{
		expect(
			{
				phone: mobilePagePadding(390, NO_INSETS),
				tablet: mobilePagePadding(800, NO_INSETS),
			},
		).toStrictEqual(
			{
				phone:
				{
					left: 16,
					right: 24,
				},
				tablet:
				{
					left: 40,
					right: 40,
				},
			},
		);
	});

	it("never goes under the safe-area insets", () =>
	{
		expect(
			mobilePagePadding(
				390,
				{
					left: 47,
					right: 30,
				},
			),
		).toStrictEqual(
			{
				left: 47,
				right: 30,
			},
		);
	});
});

describe("phone page style", () =>
{
	it("is upstream's measured .page inline style at 390 wide", () =>
	{
		expect(
			pageStyle(
				{
					fullWidth: false,
					width: 390,
					searching: false,
					mobile: true,
				},
			),
		).toStrictEqual(
			{
				minHeight: "calc(100vh - 82px)",
				borderRadius: 3,
				maxWidth: "none",
				paddingLeft: 16,
				paddingRight: 24,
				paddingTop: 24,
				marginTop: 32,
				paddingBottom: 24,
			},
		);
	});

	it("adds the mobile search form's 44px to the top margin", () =>
	{
		expect(
			pageStyle(
				{
					fullWidth: false,
					width: 390,
					searching: false,
					mobile: true,
					searchFormVisible: true,
				},
			).marginTop,
		).toBe(76);
	});

	it("adds 25px while offline", () =>
	{
		expect(
			pageStyle(
				{
					fullWidth: false,
					width: 390,
					searching: false,
					mobile: true,
					offline: true,
				},
			).marginTop,
		).toBe(57);
	});

	it("hides horizontal overflow on the page and pads the container's bottom for flying menus", () =>
	{
		expect(
			{
				page: pageClassName(
					{
						searching: false,
						showCompleted: false,
						mobile: true,
					},
				)
					.split(" ")
					.includes("overflow-x-hidden"),
				desktopPage: pageClassName(
					{
						searching: false,
						showCompleted: false,
					},
				)
					.split(" ")
					.includes("overflow-x-hidden"),
				container: pageContainerClassName(true).endsWith("pageContainer [.fly_&]:pb-[20vh]"),
			},
		).toStrictEqual(
			{
				page: true,
				desktopPage: false,
				container: true,
			},
		);
	});
});
