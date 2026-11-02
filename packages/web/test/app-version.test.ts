import {describe, expect, it} from "vite-plus/test";
import {versionLabel, versionTags} from "../src/client/app-version.js";

const MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const EDGE = `${MAC} Edg/155.0.0.0`;

describe("version label", () =>
{
	it("tags the browser and platform like upstream's version line", () =>
	{
		expect(
			{
				mac: versionLabel("4.3.1", versionTags(MAC)),
				windows: versionTags(WINDOWS),
				iphone: versionTags(IPHONE),
				android: versionTags(ANDROID),
				edge: versionTags(EDGE),
				linux: versionTags("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0"),
				bare: versionLabel("4.3.1", []),
			},
		).toStrictEqual(
			{
				mac: "4.3.1 [chrome-155, mac]",
				windows: ["chrome-155", "win"],
				iphone: ["ios-17.5"],
				android: ["chrome-130", "android-14"],
				edge: ["mac"],
				linux: ["linx"],
				bare: "4.3.1",
			},
		);
	});
});
