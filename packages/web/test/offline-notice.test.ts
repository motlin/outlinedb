// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

const {isStalled, oldestInFlightStart} = await import("../src/client/sync-health.js");
const {OfflineNoticeBar} = await import("../src/client/components/offline-notice.js");

const BUTTON =
	'<button type="button" class="bg-transparent border-0 p-0 text-primary font-semibold underline cursor-pointer">Try syncing now</button>';

function bar(entered: boolean): string
{
	return `<div class="fixed right-sar border-t border-b border-solid border-primary text-center text-primary transition-transform duration-200 ease-base print:hidden flex flex-wrap items-center justify-center gap-x-m gap-y-xs px-l py-s text-s leading-base bg-warning offlineNotice" style="bottom:0;top:unset;left:0px;transform:translateY(${entered ? "0" : "100%"});z-index:500"><span><strong>Changes are not syncing.</strong> Keep the OutlineDB app open while we reconnect.</span>${BUTTON}</div>`;
}

describe("offline notice", () =>
{
	it("is stalled once a write has been in flight for 2 minutes", () =>
	{
		expect([
			isStalled(
				{
					oldestInFlightStartedAt: null,
					now: 1e6,
				},
			),
			isStalled(
				{
					oldestInFlightStartedAt: 0,
					now: 119_999,
				},
			),
			isStalled(
				{
					oldestInFlightStartedAt: 0,
					now: 120_000,
				},
			),
		]).toStrictEqual([false, false, true]);
	});

	it("takes the earliest start among pending mutations", () =>
	{
		expect([
			oldestInFlightStart([]),
			oldestInFlightStart([
				{
					state:
					{
						status: "pending",
						submittedAt: 50,
					},
				},
				{
					state:
					{
						status: "success",
						submittedAt: 1,
					},
				},
				{
					state:
					{
						status: "pending",
						submittedAt: 20,
					},
				},
			]),
		]).toStrictEqual([null, 20]);
	});

	it("renders the exact upstream bar, sliding by `entered`", () =>
	{
		expect([
			renderToStaticMarkup(
				createElement(
					OfflineNoticeBar,
					{
						entered: true,
						left: 0,
						onRetry: () =>
						{
						},
					},
				),
			),
			renderToStaticMarkup(
				createElement(
					OfflineNoticeBar,
					{
						entered: false,
						left: 0,
						onRetry: () =>
						{
						},
					},
				),
			),
		]).toStrictEqual([bar(true), bar(false)]);
	});
});
