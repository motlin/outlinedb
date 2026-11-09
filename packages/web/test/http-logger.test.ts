import {describe, expect, it} from "vite-plus/test";
import {httpLoggingEnabled, loggingFetch} from "../src/server/http-logger.js";

function recorder() {
	const lines: string[] = [];
	return {
		lines,
		log: (line: string) => {
			lines.push(line);
		},
	};
}

describe("loggingFetch", () => {
	it("logs a JSON request and response with method, url, headers, body, status and elapsed time", async () => {
		const {lines, log} = recorder();
		const clock = [100, 142];
		const inner: typeof fetch = async () =>
			Promise.resolve(
				new Response('{"id":"n1"}', {
					status: 201,
					statusText: "Created",
					headers: {"content-type": "application/json"},
				}),
			);
		const fetchWithLog = loggingFetch(inner, log, {now: () => clock.shift() ?? 0});

		const response = await fetchWithLog("https://workflowy.com/api/v1/nodes", {
			method: "POST",
			headers: {Authorization: "Bearer secret", "Content-Type": "application/json"},
			body: '{"name":"x"}',
		});

		await expect(response.text()).resolves.toBe('{"id":"n1"}');
		expect(lines).toStrictEqual([
			"[HTTP] >>> POST https://workflowy.com/api/v1/nodes",
			"[HTTP]     header authorization: «redacted»",
			"[HTTP]     header content-type: application/json",
			'[HTTP]     body {"name":"x"}',
			"[HTTP] <<< 201 Created POST https://workflowy.com/api/v1/nodes (42 ms)",
			'[HTTP]     body {"id":"n1"}',
		]);
	});

	it("decodes a form-encoded body into one line per field and defaults the method to GET", async () => {
		const {lines, log} = recorder();
		const inner: typeof fetch = async () => Promise.resolve(new Response("", {status: 200, statusText: "OK"}));
		const fetchWithLog = loggingFetch(inner, log, {now: () => 0});

		await fetchWithLog("https://workflowy.com/push_and_poll", {
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: "client_id=abc&push_poll_data=%5B%7B%22a%22%3A1%7D%5D",
		});

		expect(lines).toStrictEqual([
			"[HTTP] >>> GET https://workflowy.com/push_and_poll",
			"[HTTP]     header content-type: application/x-www-form-urlencoded",
			"[HTTP]     form client_id=abc",
			'[HTTP]     form push_poll_data=[{"a":1}]',
			"[HTTP] <<< 200 OK GET https://workflowy.com/push_and_poll (0 ms)",
			"[HTTP]     body ",
		]);
	});

	it("redacts credential headers and credential form fields", async () => {
		const {lines, log} = recorder();
		const inner: typeof fetch = async () => Promise.resolve(new Response("", {status: 200, statusText: "OK"}));
		const fetchWithLog = loggingFetch(inner, log, {now: () => 0});

		await fetchWithLog("https://workflowy.com/ajax_login", {
			method: "POST",
			headers: {
				Cookie: "sessionid=placeholder-session",
				"Set-Cookie": "sessionid=placeholder-session; Path=/",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "username=alice%40example.com&password=placeholder-password&sessionid=placeholder-session&token=placeholder-token&api_token=placeholder-token",
		});

		expect(lines).toStrictEqual([
			"[HTTP] >>> POST https://workflowy.com/ajax_login",
			"[HTTP]     header content-type: application/x-www-form-urlencoded",
			"[HTTP]     header cookie: «redacted»",
			"[HTTP]     header set-cookie: «redacted»",
			"[HTTP]     form username=alice@example.com",
			"[HTTP]     form password=«redacted»",
			"[HTTP]     form sessionid=«redacted»",
			"[HTTP]     form token=«redacted»",
			"[HTTP]     form api_token=«redacted»",
			"[HTTP] <<< 200 OK POST https://workflowy.com/ajax_login (0 ms)",
			"[HTTP]     body ",
		]);
	});

	it("truncates a long response body and says how much was cut", async () => {
		const {lines, log} = recorder();
		const inner: typeof fetch = async () =>
			Promise.resolve(new Response("abcdefghij", {status: 200, statusText: "OK"}));
		const fetchWithLog = loggingFetch(inner, log, {now: () => 0, maxBodyChars: 4});

		await fetchWithLog("https://workflowy.com/get_initialization_data");

		expect(lines).toStrictEqual([
			"[HTTP] >>> GET https://workflowy.com/get_initialization_data",
			"[HTTP] <<< 200 OK GET https://workflowy.com/get_initialization_data (0 ms)",
			"[HTTP]     body abcd... [6 more chars]",
		]);
	});

	it("logs a network failure and rethrows it", async () => {
		const {lines, log} = recorder();
		const inner: typeof fetch = async () => Promise.reject(new TypeError("fetch failed"));
		const fetchWithLog = loggingFetch(inner, log, {now: () => 0});

		await expect(fetchWithLog("https://workflowy.com/x")).rejects.toThrow("fetch failed");
		expect(lines).toStrictEqual([
			"[HTTP] >>> GET https://workflowy.com/x",
			"[HTTP] !!! GET https://workflowy.com/x failed (0 ms): TypeError: fetch failed",
		]);
	});
});

describe("httpLoggingEnabled", () => {
	it("is on only for OUTLINEDB_HTTP_LOGGING=true, like the SQL query log switch", () => {
		expect(httpLoggingEnabled({OUTLINEDB_HTTP_LOGGING: "true"})).toBe(true);
		expect(httpLoggingEnabled({OUTLINEDB_HTTP_LOGGING: "1"})).toBe(false);
		expect(httpLoggingEnabled({})).toBe(false);
	});
});
