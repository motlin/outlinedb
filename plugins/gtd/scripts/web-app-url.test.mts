// Run: node --test plugins/gtd/scripts/web-app-url.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {webAppUrl} from "./web-app-url.mts";

test("webAppUrl defaults to the ladder's web app host", () =>
{
	const saved = process.env.REBALANCE_WEB_APP_URL;
	delete process.env.REBALANCE_WEB_APP_URL;
	try
	{
		assert.strictEqual(webAppUrl("/decisions/meetings").href, "https://workflowy.m4.notlin.com/decisions/meetings");
	}
	finally
	{
		if (saved !== undefined)
		{
			process.env.REBALANCE_WEB_APP_URL = saved;
		}
	}
});
