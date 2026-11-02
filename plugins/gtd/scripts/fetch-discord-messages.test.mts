// Run: node --test plugins/gtd/scripts/fetch-discord-messages.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import type {DiscordMessage, FetchImpl, FetchResponse} from "./fetch-discord-messages.mts";
import
{
	fetchMessagesSince,
	maxSnowflake,
	snowflakeFromTime,
	snowflakeToIso,
	toScanRecord,
} from "./fetch-discord-messages.mts";

const message = (id: string, overrides: Partial<DiscordMessage> = {}): DiscordMessage => (
{
	id,
	channel_id: "200",
	content: `message ${id}`,
	timestamp: snowflakeToIso(id),
	author:
	{
		id: "9",
		username: "alice",
		global_name: "Alice",
	},
	attachments: [],
	...overrides,
});

const page = (body: unknown, status = 200): FetchResponse => (
{
	ok: status >= 200 && status < 300,
	status,
	json: async () => Promise.resolve(body),
});

function fakeFetch(responses: FetchResponse[]):
{
	fetchImpl: FetchImpl;
	calls:
	{
		url: string;
		authorization: string | undefined;
	}[];
}
{
	const calls:
	{
		url: string;
		authorization: string | undefined;
	}[] = [];
	const fetchImpl: FetchImpl = async (url, init) =>
	{
		calls.push(
			{
				url,
				authorization: init.headers.Authorization,
			},
		);
		const next = responses.shift();
		if (!next)
		{
			return Promise.reject(new Error(`unexpected request ${url}`));
		}
		return Promise.resolve(next);
	};
	return {
		fetchImpl,
		calls,
	};
}

test("snowflakeFromTime and snowflakeToIso round-trip through the Discord epoch", () =>
{
	const id = snowflakeFromTime(Date.parse("2026-10-01T12:00:00.000Z"));
	assert.deepStrictEqual(
		{
			id,
			iso: snowflakeToIso(id),
		},
		{
			id: "1555187525222400000",
			iso: "2026-10-01T12:00:00.000Z",
		},
	);
});

test("maxSnowflake compares numerically, not lexically", () =>
{
	assert.strictEqual(maxSnowflake(["999", "1000", "200"]), "1000");
});

test("maxSnowflake returns null for an empty list", () =>
{
	assert.strictEqual(maxSnowflake([]), null);
});

test("fetchMessagesSince pages forward with after= until a short page, returning messages oldest first", async () =>
{
	const firstPage = Array.from(
		{
			length: 100,
		},
		(_, index) => message(String(1100 - index)),
	);
	const {fetchImpl, calls} = fakeFetch([page(firstPage), page([message("1102"), message("1101")])]);

	const messages = await fetchMessagesSince(
		{
			channelId: "200",
			afterId: "1000",
			token: "tok",
			fetchImpl,
		},
	);

	assert.deepStrictEqual(
		{
			calls,
			ids: [messages[0]?.id, messages[99]?.id, messages[100]?.id, messages[101]?.id],
			count: messages.length,
		},
		{
			calls: [
				{
					url: "https://discord.com/api/v10/channels/200/messages?limit=100&after=1000",
					authorization: "Bot tok",
				},
				{
					url: "https://discord.com/api/v10/channels/200/messages?limit=100&after=1100",
					authorization: "Bot tok",
				},
			],
			ids: ["1001", "1100", "1101", "1102"],
			count: 102,
		},
	);
});

test("fetchMessagesSince stops at maxPages so a stale cursor cannot pull the whole history", async () =>
{
	const full = (start: number): DiscordMessage[] =>
		Array.from(
			{
				length: 100,
			},
			(_, index) => message(String(start + index)),
		);
	const {fetchImpl, calls} = fakeFetch([page(full(1001)), page(full(1101))]);

	const messages = await fetchMessagesSince(
		{
			channelId: "200",
			afterId: "1000",
			token: "tok",
			fetchImpl,
			maxPages: 2,
		},
	);

	assert.deepStrictEqual(
		{
			count: messages.length,
			requests: calls.length,
		},
		{
			count: 200,
			requests: 2,
		},
	);
});

test("fetchMessagesSince waits out a 429 and retries the same page", async () =>
{
	const waits: number[] = [];
	const {fetchImpl, calls} = fakeFetch([
		page(
			{
				retry_after: 0.25,
			},
			429,
		),
		page([message("1001")]),
	]);

	const messages = await fetchMessagesSince(
		{
			channelId: "200",
			afterId: "1000",
			token: "tok",
			fetchImpl,
			sleep: async (ms) =>
			{
				waits.push(ms);
				return Promise.resolve();
			},
		},
	);

	assert.deepStrictEqual(
		{
			ids: messages.map((m) => m.id),
			waits,
			urls: calls.map((c) => c.url),
		},
		{
			ids: ["1001"],
			waits: [250],
			urls: [
				"https://discord.com/api/v10/channels/200/messages?limit=100&after=1000",
				"https://discord.com/api/v10/channels/200/messages?limit=100&after=1000",
			],
		},
	);
});

test("fetchMessagesSince throws a readable error on a non-retryable failure", async () =>
{
	const {fetchImpl} = fakeFetch([
		page(
			{
				message: "Missing Access",
				code: 50_001,
			},
			403,
		),
	]);

	await assert.rejects(
		fetchMessagesSince(
			{
				channelId: "200",
				afterId: "1000",
				token: "tok",
				fetchImpl,
			},
		),
		{
			message: "Discord API 403 for channel 200: Missing Access (code 50001)",
		},
	);
});

test("toScanRecord flattens a message into the fields the scanner reads, with a jump link", () =>
{
	const raw = message(
		"1555187525222400000",
		{
			content: "Blueprint import crashes on empty string",
			author:
			{
				id: "9",
				username: "alice",
				global_name: "Alice",
			},
			attachments: [
				{
					filename: "crash.png",
					url: "https://cdn.example.com/crash.png",
				},
			],
			message_reference:
			{
				message_id: "1555187525222300000",
			},
			thread:
			{
				id: "300",
				name: "Import crash",
			},
		},
	);

	assert.deepStrictEqual(
		toScanRecord(raw, "100"),
		{
			id: "1555187525222400000",
			timestamp: "2026-10-01T12:00:00.000Z",
			author: "Alice",
			authorUsername: "alice",
			isBot: false,
			content: "Blueprint import crashes on empty string",
			attachments: [
				{
					filename: "crash.png",
					url: "https://cdn.example.com/crash.png",
				},
			],
			replyToId: "1555187525222300000",
			threadName: "Import crash",
			url: "https://discord.com/channels/100/200/1555187525222400000",
		},
	);
});

test("toScanRecord falls back to username and marks bots", () =>
{
	const raw = message(
		"1001",
		{
			author:
			{
				id: "8",
				username: "ci-bot",
				bot: true,
			},
		},
	);

	assert.deepStrictEqual(
		toScanRecord(raw, "100"),
		{
			id: "1001",
			timestamp: snowflakeToIso("1001"),
			author: "ci-bot",
			authorUsername: "ci-bot",
			isBot: true,
			content: "message 1001",
			attachments: [],
			replyToId: null,
			threadName: null,
			url: "https://discord.com/channels/100/200/1001",
		},
	);
});
