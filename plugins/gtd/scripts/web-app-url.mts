// The local web app (packages/web) that serves the ladder and decision pages.

/** `path` on the web app, at REBALANCE_WEB_APP_URL when set. */
export function webAppUrl(path: string): URL
{
	return new URL(path, process.env.REBALANCE_WEB_APP_URL ?? "https://workflowy.m4.notlin.com");
}
