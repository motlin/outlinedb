// The local web app (packages/web) that serves the ladder and decision pages,
// and the WebSocket Monitor watches. Everything resolves one origin so the
// pages and the socket never disagree. The browser runs on this Mac, so the
// default is loopback; set REBALANCE_WEB_APP_URL to the tailnet hostname only
// when a page must open on another device.

function origin(): string
{
	return process.env.REBALANCE_WEB_APP_URL ?? "http://localhost:5175";
}

/** `path` on the web app. */
export function webAppUrl(path: string): URL
{
	return new URL(path, origin());
}

/** `path` as a WebSocket URL on the same origin: ws:// for HTTP, wss:// for HTTPS. */
export function webAppWsUrl(path: string): URL
{
	const url = webAppUrl(path);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url;
}
