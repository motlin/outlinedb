// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import
{
	applyDeviceClass,
	bodyDeviceClass,
	detectMobile,
	headerHeight,
	isAndroid,
	isIos,
} from "../src/client/is-mobile.js";

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPAD =
	"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC_CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

describe("detectMobile", () =>
{
	it("is true for iPhone, Android and iPad user agents and false for desktop Chrome", () =>
	{
		expect(
			{
				iphone: detectMobile(
					{
						userAgent: IPHONE,
						platform: "iPhone",
						maxTouchPoints: 5,
					},
				),
				android: detectMobile(
					{
						userAgent: ANDROID,
						platform: "Linux armv81",
						maxTouchPoints: 5,
					},
				),
				ipad: detectMobile(
					{
						userAgent: IPAD,
						platform: "iPad",
						maxTouchPoints: 5,
					},
				),
				mac: detectMobile(
					{
						userAgent: MAC_CHROME,
						platform: "MacIntel",
						maxTouchPoints: 0,
					},
				),
			},
		).toStrictEqual(
			{
				iphone: true,
				android: true,
				ipad: true,
				mac: false,
			},
		);
	});

	it("does not treat a touch Mac as a phone unless it is the iOS app", () =>
	{
		expect(
			{
				touchMac: detectMobile(
					{
						userAgent: MAC_CHROME,
						platform: "MacIntel",
						maxTouchPoints: 5,
					},
				),
				iosApp: detectMobile(
					{
						userAgent: `${MAC_CHROME} ios:application`,
						platform: "MacIntel",
						maxTouchPoints: 5,
					},
				),
			},
		).toStrictEqual(
			{
				touchMac: false,
				iosApp: true,
			},
		);
	});
});

describe("platform helpers", () =>
{
	it("tells iOS from Android and picks the header height", () =>
	{
		expect(
			{
				iosIsIos: isIos(IPHONE),
				androidIsIos: isIos(ANDROID),
				androidIsAndroid: isAndroid(ANDROID),
				iosHeight: headerHeight(IPHONE),
				androidHeight: headerHeight(ANDROID),
			},
		).toStrictEqual(
			{
				iosIsIos: true,
				androidIsIos: false,
				androidIsAndroid: true,
				iosHeight: 49,
				androidHeight: 56,
			},
		);
	});

	it("names the body class", () =>
	{
		expect([bodyDeviceClass(true), bodyDeviceClass(false)]).toStrictEqual(["is-mobile", "is-desktop"]);
	});
});

describe("applyDeviceClass", () =>
{
	it("replaces is-desktop with is-mobile and sets the header height on a phone", () =>
	{
		const body = document.createElement("body");
		body.className = "is-desktop font-system";
		applyDeviceClass(body, true, ANDROID);
		expect(
			{
				className: body.className,
				height: body.style.getPropertyValue("--wf-header-height"),
			},
		).toStrictEqual(
			{
				className: "is-mobile font-system",
				height: "56px",
			},
		);
	});

	it("leaves a desktop body alone", () =>
	{
		const body = document.createElement("body");
		body.className = "is-desktop font-system";
		applyDeviceClass(body, false, MAC_CHROME);
		expect(
			{
				className: body.className,
				height: body.style.getPropertyValue("--wf-header-height"),
			},
		).toStrictEqual(
			{
				className: "is-desktop font-system",
				height: "",
			},
		);
	});
});
