// Read new messages from one Discord channel through a read-only bot, for the capture discord-scanner.
//
// The bot token comes from DISCORD_BOT_TOKEN (gitignored .envrc), never from this plugin. The channel,
// its guild, and the cursor live in Workflowy under Metadata > ⚙️ Scanner State > discord-scanner.
//
//   node fetch-discord-messages.mts --channel <id> --guild <id> (--after <messageId> | --since-days <n>)
//     -> {channelId, guildId, afterId, newestId, truncated, messages: [scan record, oldest first]}
//
// Exit codes: 0 success, 2 missing token or arguments, 1 Discord API failure (message on stderr).

import {errorMessage, isObject, numberField, stringField} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface DiscordAuthor {
	id?: string;
	username: string;
	global_name?: string | null;
	bot?: boolean;
}

export interface DiscordMessage {
	id: string;
	channel_id: string;
	content: string;
	timestamp: string;
	author: DiscordAuthor;
	attachments?: {filename: string; url: string}[];
	message_reference?: {message_id?: string};
	thread?: {id?: string; name?: string};
}

export interface ScanRecord {
	id: string;
	timestamp: string;
	author: string;
	authorUsername: string;
	isBot: boolean;
	content: string;
	attachments: {filename: string; url: string}[];
	replyToId: string | null;
	threadName: string | null;
	url: string;
}

/** The slice of `fetch`'s Response this script reads. */
export interface FetchResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

export type FetchImpl = (url: string, init: {headers: Record<string, string>}) => Promise<FetchResponse>;

function isDiscordMessage(value: unknown): value is DiscordMessage {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		typeof value.channel_id === "string" &&
		typeof value.content === "string" &&
		typeof value.timestamp === "string" &&
		isObject(value.author) &&
		typeof value.author.username === "string"
	);
}

const API = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1_420_070_400_000n;
const PAGE_SIZE = 100;

export function snowflakeFromTime(ms: number): string {
	return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}

export function snowflakeToIso(id: string): string {
	return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}

export function maxSnowflake(ids: readonly string[]): string | null {
	return ids.reduce<string | null>((max, id) => (max === null || BigInt(id) > BigInt(max) ? id : max), null);
}

const byId = (a: DiscordMessage, b: DiscordMessage): number =>
	BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;

const defaultSleep = async (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export async function fetchMessagesSince({
	channelId,
	afterId,
	token,
	fetchImpl = fetch,
	sleep = defaultSleep,
	maxPages = 10,
}: {
	channelId: string;
	afterId: string;
	token: string;
	fetchImpl?: FetchImpl;
	sleep?: (ms: number) => Promise<void>;
	maxPages?: number;
}): Promise<DiscordMessage[]> {
	const messages: DiscordMessage[] = [];
	let cursor = afterId;
	for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
		const url = `${API}/channels/${channelId}/messages?limit=${PAGE_SIZE}&after=${cursor}`;
		const response = await fetchImpl(url, {headers: {Authorization: `Bot ${token}`}});
		if (response.status === 429) {
			const throttle = await response.json();
			const retryAfter = isObject(throttle) ? (numberField(throttle, "retry_after") ?? Number.NaN) : Number.NaN;
			await sleep(Math.ceil(retryAfter * 1000));
			pageIndex--;
			continue;
		}
		const body = await response.json();
		if (!response.ok) {
			const detail = isObject(body) ? body : {};
			throw new Error(
				`Discord API ${response.status} for channel ${channelId}: ${stringField(detail, "message") ?? "undefined"} (code ${String(detail.code)})`,
			);
		}
		if (!Array.isArray(body) || !body.every(isDiscordMessage)) {
			throw new TypeError(`Discord API returned an unexpected message list for channel ${channelId}`);
		}
		const sorted = [...body].toSorted(byId);
		messages.push(...sorted);
		if (sorted.length < PAGE_SIZE) {
			break;
		}
		cursor = sorted.at(-1)?.id ?? cursor;
	}
	return messages;
}

export function toScanRecord(message: DiscordMessage, guildId: string): ScanRecord {
	return {
		id: message.id,
		timestamp: message.timestamp,
		author: message.author.global_name ?? message.author.username,
		authorUsername: message.author.username,
		isBot: message.author.bot === true,
		content: message.content,
		attachments: (message.attachments ?? []).map(({filename, url}) => ({filename, url})),
		replyToId: message.message_reference?.message_id ?? null,
		threadName: message.thread?.name ?? null,
		url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
	};
}

function parseArgs(argv: readonly string[]): Partial<Record<string, string>> {
	const args: Partial<Record<string, string>> = {};
	for (let index = 0; index < argv.length; index += 2) {
		args[(argv[index] ?? "").replace(/^--/u, "")] = argv[index + 1];
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const token = process.env.DISCORD_BOT_TOKEN;
	if (!token) {
		console.error("DISCORD_BOT_TOKEN is not set");
		process.exit(2);
	}
	const channelId = args.channel;
	const guildId = args.guild;
	if (!channelId || !guildId || (!args.after && !args["since-days"])) {
		console.error(
			"usage: fetch-discord-messages.mts --channel <id> --guild <id> (--after <id> | --since-days <n>)",
		);
		process.exit(2);
	}
	const afterId = args.after ?? snowflakeFromTime(Date.now() - Number(args["since-days"]) * 86_400_000);
	const maxPages = 10;
	try {
		const raw = await fetchMessagesSince({channelId, afterId, token, maxPages});
		const messages = raw.map((message) => toScanRecord(message, guildId));
		const result = {
			channelId,
			guildId,
			afterId,
			newestId: maxSnowflake(messages.map((message) => message.id)) ?? afterId,
			truncated: raw.length >= maxPages * PAGE_SIZE,
			messages,
		};
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(errorMessage(error));
		process.exit(1);
	}
}

if (isMain(import.meta.url)) {
	await main();
}
