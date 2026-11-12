// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

const {syncHealth, classifyWriteFailure} = await import("../src/client/sync-health.js");
const {RequestStatusError} = await import("../src/client/request-error.js");
const {GuiBannerView} = await import("../src/client/components/gui-banner.js");

describe("syncHealth", () =>
{
	it("warns on the 2nd consecutive network failure and clears on success", () =>
	{
		const events = [
			"write-failed-network",
			"write-failed-client",
			"write-failed-network",
			"write-succeeded",
			"browser-offline",
			"browser-offline",
			"browser-online",
		] as const;
		let state =
		{
			failures: 0,
		};
		const warns: boolean[] = [];
		for (const event of events)
		{
			const next = syncHealth(state, event);
			state =
			{
				failures: next.failures,
			};
			warns.push(next.warn);
		}
		expect(warns).toStrictEqual([false, false, true, false, false, true, true]);
	});

	it("classifies TypeError and 5xx as network failures and 4xx as client failures", () =>
	{
		expect([
			classifyWriteFailure(new TypeError("Failed to fetch")),
			classifyWriteFailure(new RequestStatusError(503, "x")),
			classifyWriteFailure(new RequestStatusError(404, "x")),
		]).toStrictEqual(["write-failed-network", "write-failed-network", "write-failed-client"]);
	});
});

describe("sync warning banner", () =>
{
	it("renders upstream's two-line warning inside the GuiBanner host", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				GuiBannerView,
				{
					kind: "warn",
					title: "Warning: We are unable to save your changes right now.",
					text: "Your changes will be saved when we can reconnect to the server.",
					left: 0,
					onClose: () =>
					{
					},
					onAction: () =>
					{
					},
				},
			),
		);
		expect(markup).toContain(
			'<div class="messageContent flex-grow flex-shrink leading-base"><div><strong>Warning: We are unable to save your changes right now.</strong><br/>Your changes will be saved when we can reconnect to the server.</div></div>',
		);
		expect(markup).toContain("bg-warning");
	});
});
