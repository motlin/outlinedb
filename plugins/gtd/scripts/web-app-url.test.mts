// Run: node --test plugins/gtd/scripts/web-app-url.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {webAppUrl, webAppWsUrl} from "./web-app-url.mts";

function withOrigin(origin: string | undefined, body: () => void): void
{
	const saved = process.env.REBALANCE_WEB_APP_URL;
	if (origin === undefined)
	{
		delete process.env.REBALANCE_WEB_APP_URL;
	}
	else
	{
		process.env.REBALANCE_WEB_APP_URL = origin;
	}
	try
	{
		body();
	}
	finally
	{
		if (saved === undefined)
		{
			delete process.env.REBALANCE_WEB_APP_URL;
		}
		else
		{
			process.env.REBALANCE_WEB_APP_URL = saved;
		}
	}
}

test("pages and WebSockets share one origin, defaulting to the web app on this Mac", () =>
{
	withOrigin(undefined, () =>
	{
		assert.deepStrictEqual(
			[webAppUrl("/decisions/meetings").href, webAppWsUrl("/api/v1/ladder/events").href],
			["http://localhost:5175/decisions/meetings", "ws://localhost:5175/api/v1/ladder/events"],
		);
	});
	withOrigin("https://workflowy.m4.notlin.com", () =>
	{
		assert.deepStrictEqual(
			[webAppUrl("/ladder").href, webAppWsUrl("/api/v1/ladder/events").href],
			["https://workflowy.m4.notlin.com/ladder", "wss://workflowy.m4.notlin.com/api/v1/ladder/events"],
		);
	});
});
