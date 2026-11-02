import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import {VideoPreview, videoWidthCap} from "../src/client/components/video-preview.js";

describe("videoWidthCap", () =>
{
	it("never exceeds the natural width and caps the height at 90% of the window", () =>
	{
		expect([
			videoWidthCap(
				{
					videoWidth: 1920,
					videoHeight: 1080,
					innerHeight: 860,
				},
			),
			videoWidthCap(
				{
					videoWidth: 640,
					videoHeight: 360,
					innerHeight: 860,
				},
			),
		]).toStrictEqual([1376, 640]);
	});
});

describe("VideoPreview", () =>
{
	it("renders upstream's FilePlayer markup with native controls", () =>
	{
		expect(renderToStaticMarkup(<VideoPreview nodeId="n1" />)).toBe(
			'<div class="[display:inherit] mobile:flex mobile:mr-[30px]"><div style="width:calc(min(100%, var(--video-width-real), var(--video-width, 100%)));height:auto"><video src="/api/v1/files/n1/original" preload="auto" controls="" style="width:100%;height:auto"></video></div></div>',
		);
	});
});
