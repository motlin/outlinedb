import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {CacheService} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {standaloneContext} from "./helpers/local-context.js";
import {httpAppFor} from "./http-app-for.js";

const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
type MetadataChange = Parameters<WorkflowyInternalAdapter["setRootMetaValues"]>[0][number];

const NOTES = "1a2b3c4d-0000-4000-8000-000000000001";

/** Apply root-metadata changes to a plain object, as the real adapter's cache does. */
function applyChanges(meta: Record<string, unknown>, changes: MetadataChange[]): void
{
	for (const {path, value} of changes)
	{
		let target = meta;
		for (const key of path.slice(0, -1))
		{
			target[key] ??= {};
			target = target[key] as Record<string, unknown>;
		}
		const last = path.at(-1)!;
		if (value === undefined)
		{
			Reflect.deleteProperty(target, last);
		}
		else
		{
			target[last] = value;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null;
}

function setup(meta: Record<string, unknown> | undefined, settings: Record<string, unknown> = {})
{
	const adapter =
	{
		getSetting: vi.fn<WorkflowyInternalAdapter["getSetting"]>(async (name) => Promise.resolve(settings[name])),
		setSetting: vi.fn<WorkflowyInternalAdapter["setSetting"]>(async (name, value) =>
		{
			settings[name] = value;
			return Promise.resolve();
		}),
		getRootMeta: vi.fn<WorkflowyInternalAdapter["getRootMeta"]>(async (path) =>
			Promise.resolve(path.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), meta)),
		),
		setRootMetaValues: vi.fn<WorkflowyInternalAdapter["setRootMetaValues"]>(async (changes) =>
		{
			applyChanges(meta!, changes);
			return Promise.resolve();
		}),
		getAccount: vi.fn<WorkflowyInternalAdapter["getAccount"]>(async () =>
			Promise.resolve(
				{
					userId: "42",
					joinedAt: new Date(1_500_000_000 * 1000),
					fullName: null,
				},
			),
		),
	};
	// A week-start change looks for a calendar root to re-layout, so the context needs a (calendar-less) cache.
	const db = drizzle(
		new DatabaseConstructor(":memory:"),
		{
			schema,
		},
	);
	migrate(
		db,
		{
			migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations"),
		},
	);
	const ctx =
	{
		db,
		cacheService: new CacheService(db),
		config:
		{
			accountEmail: "",
		} as ServerContext["config"],
		internalAdapter: () => (meta ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const request = async (method: string, path: string, body?: unknown) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1${path}`,
				{
					method,
					headers:
					{
						"content-type": "application/json",
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			),
		);
		return {
			status: res.status,
			body: (await res.json()) as unknown,
		};
	};
	return {
		adapter,
		request,
	};
}

const EMPTY =
{
	dateFormat: null,
	timeFormat: null,
	weekStartDay: null,
	slashDiscovered: false,
	calendarTooltipSeen: false,
	emojiSelected: null,
	aiEmbeddingStatus: null,
	aiEmbeddingTooltipDismissed: false,
	notesRootId: null,
	showCompleted: false,
	showKeyboardShortcuts: false,
	sameColorForLinks: false,
	theme: null,
	font: null,
	displayImagePreviewsAsThumbnails: false,
	ignoreYoutube: false,
	ignoreYtShort: false,
	ignoreTwitter: false,
	ignoreLoom: false,
	unsubscribeFromSummaryEmails: false,
	unsubscribeFromCommentsEmails: false,
	backupToDropbox: false,
	weeklyReportOn: false,
	latestColor: null,
	searchForChangesAfter: null,
	account: null,
	mfa: null,
	changelogRead: null,
};

describe("GET /api/v1/preferences", () =>
{
	it("reads the root metadata fields", async () =>
	{
		const {request} = setup(
			{
				dateFormat: "MMM D, YYYY",
				timeFormat: "h:mm a",
				weekStartDay: 1,
				slash:
				{
					discovered: true,
				},
				notesRootId: NOTES,
				starring:
				{
					locations: {},
				},
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					dateFormat: "MMM D, YYYY",
					timeFormat: "h:mm a",
					weekStartDay: 1,
					slashDiscovered: true,
					notesRootId: NOTES,
				},
			},
		);
	});

	it("reads calendarTooltipSeen from calendar.tooltip_seen", async () =>
	{
		const {request} = setup(
			{
				calendar:
				{
					rootId: "cal",
					tooltip_seen: true,
				},
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					calendarTooltipSeen: true,
				},
			},
		);
	});

	it("reads emojiSelected from emoji.options.selected", async () =>
	{
		const {request} = setup(
			{
				emoji:
				{
					options:
					{
						selected: "noto",
					},
				},
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					emojiSelected: "noto",
				},
			},
		);
	});

	it("reads the AI embedding onboarding state from ai.embeddingStatus and ai.embedding_tooltip_dismissed", async () =>
	{
		const {request} = setup(
			{
				ai:
				{
					embeddingStatus: "finished",
					embedding_tooltip_dismissed: true,
					mailboxId: "mb",
				},
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					aiEmbeddingStatus: "finished",
					aiEmbeddingTooltipDismissed: true,
				},
			},
		);
	});

	it("maps the yes/no account settings to booleans", async () =>
	{
		const {request} = setup(
			{},
			{
				show_completed: "yes",
				show_keyboard_shortcuts: "no",
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					showCompleted: true,
					showKeyboardShortcuts: false,
				},
			},
		);
	});

	it("round-trips same_color_for_links as sameColorForLinks", async () =>
	{
		const {adapter, request} = setup(
			{},
			{
				same_color_for_links: "yes",
			},
		);

		const read = await request("GET", "/preferences");
		const written = await request(
			"PATCH",
			"/preferences",
			{
				sameColorForLinks: false,
			},
		);

		expect(
			{
				read,
				written,
				settings: adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				read:
				{
					status: 200,
					body:
					{
						...EMPTY,
						sameColorForLinks: true,
					},
				},
				written:
				{
					status: 200,
					body: EMPTY,
				},
				settings: [["same_color_for_links", false]],
			},
		);
	});

	it("reads boolean account settings cached after a write", async () =>
	{
		const {request} = setup(
			{},
			{
				show_completed: false,
				show_keyboard_shortcuts: true,
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					showCompleted: false,
					showKeyboardShortcuts: true,
				},
			},
		);
	});

	it("round-trips the theme as a string", async () =>
	{
		const {adapter, request} = setup(
			{},
			{
				theme: "dark",
			},
		);

		const read = await request("GET", "/preferences");
		const written = await request(
			"PATCH",
			"/preferences",
			{
				theme: "system",
			},
		);

		expect(
			{
				read,
				written,
				settings: adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				read:
				{
					status: 200,
					body:
					{
						...EMPTY,
						theme: "dark",
					},
				},
				written:
				{
					status: 200,
					body:
					{
						...EMPTY,
						theme: "system",
					},
				},
				settings: [["theme", "system"]],
			},
		);
	});

	it("round-trips the font as a string", async () =>
	{
		const {adapter, request} = setup(
			{},
			{
				font: "system",
			},
		);

		const read = await request("GET", "/preferences");
		const written = await request(
			"PATCH",
			"/preferences",
			{
				font: "etBook",
			},
		);

		expect(
			{
				read,
				written,
				settings: adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				read:
				{
					status: 200,
					body:
					{
						...EMPTY,
						font: "system",
					},
				},
				written:
				{
					status: 200,
					body:
					{
						...EMPTY,
						font: "etBook",
					},
				},
				settings: [["font", "etBook"]],
			},
		);
	});

	it("reads the media and notification account flags and the weekly report toggle", async () =>
	{
		const {request} = setup(
			{
				"weekly-report":
				{
					on: true,
				},
			},
			{
				display_image_previews_as_thumbnails: "yes",
				ignore_youtube: "yes",
				ignore_yt_short: "no",
				ignore_twitter: true,
				ignore_loom: false,
				unsubscribe_from_summary_emails: "yes",
				unsubscribe_from_comments_emails: "yes",
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					displayImagePreviewsAsThumbnails: true,
					ignoreYoutube: true,
					ignoreTwitter: true,
					unsubscribeFromSummaryEmails: true,
					unsubscribeFromCommentsEmails: true,
					weeklyReportOn: true,
				},
			},
		);
	});

	it("answers the account's name and email from its settings, and null when either is missing", async () =>
	{
		const full = setup(
			{},
			{
				username: "Alice",
				email: "alice@example.com",
			},
		);
		const partial = setup(
			{},
			{
				username: "Alice",
			},
		);

		await expect(full.request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					account:
					{
						username: "Alice",
						email: "alice@example.com",
					},
				},
			},
		);
		await expect(partial.request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body: EMPTY,
			},
		);
	});

	it("answers upstream's settings.mfa enabled state read-only, null when the account has none", async () =>
	{
		const on = setup(
			{},
			{
				mfa:
				{
					enabled: true,
				},
			},
		);
		const off = setup(
			{},
			{
				mfa:
				{
					enabled: false,
				},
			},
		);
		const absent = setup({}, {});

		const reads = await Promise.all([on, off, absent].map(async ({request}) => request("GET", "/preferences")));
		const write = await on.request(
			"PATCH",
			"/preferences",
			{
				mfa:
				{
					enabled: false,
				},
			},
		);

		expect(
			{
				reads,
				writeStatus: write.status,
				settings: on.adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				reads: [
					{
						status: 200,
						body:
						{
							...EMPTY,
							mfa:
							{
								enabled: true,
							},
						},
					},
					{
						status: 200,
						body:
						{
							...EMPTY,
							mfa:
							{
								enabled: false,
							},
						},
					},
					{
						status: 200,
						body: EMPTY,
					},
				],
				writeStatus: 400,
				settings: [],
			},
		);
	});

	it("answers changelog.read as changelogRead, keeping only boolean flags, and null when the account has none", async () =>
	{
		const read = setup(
			{
				changelog:
				{
					read:
					{
						may27_2025: true,
						june11_2025: false,
						bogus: "yes",
					},
					liked:
					{
						x: true,
					},
				},
			},
		);
		const absent = setup({});

		const reads = await Promise.all([read, absent].map(async ({request}) => request("GET", "/preferences")));

		expect(reads).toStrictEqual([
			{
				status: 200,
				body:
				{
					...EMPTY,
					changelogRead:
					{
						may27_2025: true,
						june11_2025: false,
					},
				},
			},
			{
				status: 200,
				body: EMPTY,
			},
		]);
	});

	it("maps upstream's latestColor attribute and value to a color choice", async () =>
	{
		const highlight = setup(
			{
				latestColor:
				{
					attribute: 12,
					value: 2,
				},
			},
		);
		const text = setup(
			{
				latestColor:
				{
					attribute: 11,
					value: 8,
				},
			},
		);

		await expect(highlight.request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					latestColor:
					{
						kind: "highlight",
						color: "yellow",
					},
				},
			},
		);
		await expect(text.request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					latestColor:
					{
						kind: "text",
						color: "sky",
					},
				},
			},
		);
	});

	it("answers searchForChangesAfter as the join date plus the stored client-timestamp seconds", async () =>
	{
		const {request} = setup(
			{
				searchForChangesAfter: 100,
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					...EMPTY,
					searchForChangesAfter: "2017-07-14T02:41:40.000Z",
				},
			},
		);
	});

	it("answers nulls and false for missing or mistyped values", async () =>
	{
		const {request} = setup(
			{
				dateFormat: 7,
				weekStartDay: "1",
				slash: "yes",
				latestColor:
				{
					attribute: 13,
					value: 2,
				},
				searchForChangesAfter: "100",
			},
		);

		await expect(request("GET", "/preferences")).resolves.toStrictEqual(
			{
				status: 200,
				body: EMPTY,
			},
		);
	});
});

describe("preferences in a standalone context", () =>
{
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("writes root-metadata preferences and settings to the local tables and reads them back, with no internal API", async () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: 1_700_000_000_000,
			},
		);
		const app = httpAppFor(standaloneContext());
		const request = async (method: string, body?: unknown) =>
		{
			const res = await app.fetch(
				new Request(
					"http://x/api/v1/preferences",
					{
						method,
						headers:
						{
							"content-type": "application/json",
						},
						...(body === undefined
							? {}
							:
								{
									body: JSON.stringify(body),
								}),
					},
				),
			);
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};

		const before = await request("GET");
		const patched = await request(
			"PATCH",
			{
				dateFormat: "DD/MM/YYYY",
				weekStartDay: 1,
				latestColor:
				{
					kind: "highlight",
					color: "teal",
				},
				searchForChangesAfter: "2023-11-14T22:13:20.000Z",
				showCompleted: true,
				theme: "dark",
			},
		);
		vi.setSystemTime(1_700_000_001_000);
		const cleared = await request(
			"PATCH",
			{
				dateFormat: null,
				showCompleted: false,
			},
		);

		const written =
		{
			...EMPTY,
			dateFormat: "DD/MM/YYYY",
			weekStartDay: 1,
			latestColor:
			{
				kind: "highlight",
				color: "teal",
			},
			searchForChangesAfter: "2023-11-14T22:13:20.000Z",
			showCompleted: true,
			theme: "dark",
		};
		expect(
			{
				before,
				patched,
				cleared,
				after: await request("GET"),
			},
		).toStrictEqual(
			{
				before:
				{
					status: 200,
					body: EMPTY,
				},
				patched:
				{
					status: 200,
					body: written,
				},
				cleared:
				{
					status: 200,
					body:
					{
						...written,
						dateFormat: null,
						showCompleted: false,
					},
				},
				after:
				{
					status: 200,
					body:
					{
						...written,
						dateFormat: null,
						showCompleted: false,
					},
				},
			},
		);
	});
});

describe("PATCH /api/v1/preferences", () =>
{
	it("writes dateFormat once and answers the merged preferences", async () =>
	{
		const {adapter, request} = setup(
			{
				timeFormat: "HH:mm",
			},
		);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				dateFormat: "YYYY-MM-DD ddd",
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						dateFormat: "YYYY-MM-DD ddd",
						timeFormat: "HH:mm",
					},
				},
				writes: [
					[
						[
							{
								path: ["dateFormat"],
								value: "YYYY-MM-DD ddd",
							},
						],
					],
				],
			},
		);
	});

	it("writes calendarTooltipSeen at calendar.tooltip_seen, keeping the rest of calendar", async () =>
	{
		const meta: Record<string, unknown> =
		{
			calendar:
			{
				rootId: "cal",
			},
		};
		const {adapter, request} = setup(meta);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				calendarTooltipSeen: true,
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
				meta,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						calendarTooltipSeen: true,
					},
				},
				writes: [
					[
						[
							{
								path: ["calendar", "tooltip_seen"],
								value: true,
							},
						],
					],
				],
				meta:
				{
					calendar:
					{
						rootId: "cal",
						tooltip_seen: true,
					},
				},
			},
		);
	});

	it("writes emojiSelected at emoji.options.selected", async () =>
	{
		const meta: Record<string, unknown> = {};
		const {adapter, request} = setup(meta);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				emojiSelected: "noto",
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
				meta,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						emojiSelected: "noto",
					},
				},
				writes: [
					[
						[
							{
								path: ["emoji", "options", "selected"],
								value: "noto",
							},
						],
					],
				],
				meta:
				{
					emoji:
					{
						options:
						{
							selected: "noto",
						},
					},
				},
			},
		);
	});

	it("writes aiEmbeddingStatus and aiEmbeddingTooltipDismissed under ai, keeping the rest of ai", async () =>
	{
		const meta: Record<string, unknown> =
		{
			ai:
			{
				mailboxId: "mb",
			},
		};
		const {adapter, request} = setup(meta);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				aiEmbeddingStatus: "requested",
				aiEmbeddingTooltipDismissed: true,
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
				meta,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						aiEmbeddingStatus: "requested",
						aiEmbeddingTooltipDismissed: true,
					},
				},
				writes: [
					[
						[
							{
								path: ["ai", "embeddingStatus"],
								value: "requested",
							},
							{
								path: ["ai", "embedding_tooltip_dismissed"],
								value: true,
							},
						],
					],
				],
				meta:
				{
					ai:
					{
						mailboxId: "mb",
						embeddingStatus: "requested",
						embedding_tooltip_dismissed: true,
					},
				},
			},
		);
	});

	it("writes slashDiscovered at slash.discovered", async () =>
	{
		const {adapter, request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				slashDiscovered: true,
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						slashDiscovered: true,
					},
				},
				writes: [
					[
						[
							{
								path: ["slash", "discovered"],
								value: true,
							},
						],
					],
				],
			},
		);
	});

	it("writes several fields in one push and removes a field set to null", async () =>
	{
		const {adapter, request} = setup(
			{
				dateFormat: "MMM D",
				notesRootId: NOTES,
			},
		);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				weekStartDay: 0,
				notesRootId: null,
			},
		);

		expect(
			{
				response,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						dateFormat: "MMM D",
						weekStartDay: 0,
					},
				},
				writes: [
					[
						[
							{
								path: ["weekStartDay"],
								value: 0,
							},
							{
								path: ["notesRootId"],
								value: undefined,
							},
						],
					],
				],
			},
		);
	});

	it("rejects a changelogRead patch without writing, since upstream's changelog.read is read-only here", async () =>
	{
		const {adapter, request} = setup(
			{
				changelog:
				{
					read:
					{
						may27_2025: true,
					},
				},
			},
		);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				changelogRead:
				{
					june11_2025: true,
				},
			},
		);

		expect(
			{
				status: response.status,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				writes: [],
			},
		);
	});

	it("reads and writes the Dropbox backup flag through the account settings", async () =>
	{
		const {adapter, request} = setup(
			{},
			{
				backup_to_dropbox: "yes",
			},
		);

		const read = await request("GET", "/preferences");
		const written = await request(
			"PATCH",
			"/preferences",
			{
				backupToDropbox: false,
			},
		);

		expect(
			{
				read,
				written,
				settings: adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				read:
				{
					status: 200,
					body:
					{
						...EMPTY,
						backupToDropbox: true,
					},
				},
				written:
				{
					status: 200,
					body: EMPTY,
				},
				settings: [["backup_to_dropbox", false]],
			},
		);
	});

	it("writes showCompleted through the account settings, not root metadata", async () =>
	{
		const {adapter, request} = setup(
			{},
			{
				show_completed: "yes",
			},
		);

		const response = await request(
			"PATCH",
			"/preferences",
			{
				showCompleted: false,
			},
		);

		expect(
			{
				response,
				settings: adapter.setSetting.mock.calls,
				metadata: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body: EMPTY,
				},
				settings: [["show_completed", false]],
				metadata: [],
			},
		);
	});

	it("writes metadata and both account settings in one PATCH", async () =>
	{
		const {adapter, request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				dateFormat: "MMM D",
				showCompleted: true,
				showKeyboardShortcuts: true,
			},
		);

		expect(
			{
				response,
				settings: adapter.setSetting.mock.calls,
				metadata: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						dateFormat: "MMM D",
						showCompleted: true,
						showKeyboardShortcuts: true,
					},
				},
				settings: [
					["show_completed", true],
					["show_keyboard_shortcuts", true],
				],
				metadata: [
					[
						[
							{
								path: ["dateFormat"],
								value: "MMM D",
							},
						],
					],
				],
			},
		);
	});

	it("writes ignoreLoom through the account settings and weeklyReportOn at weekly-report.on", async () =>
	{
		const {adapter, request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				ignoreLoom: true,
				weeklyReportOn: true,
			},
		);

		expect(
			{
				response,
				settings: adapter.setSetting.mock.calls,
				metadata: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 200,
					body:
					{
						...EMPTY,
						ignoreLoom: true,
						weeklyReportOn: true,
					},
				},
				settings: [["ignore_loom", true]],
				metadata: [
					[
						[
							{
								path: ["weekly-report", "on"],
								value: true,
							},
						],
					],
				],
			},
		);
	});

	it("writes latestColor as upstream's {attribute, value} and removes it with null", async () =>
	{
		const {adapter, request} = setup({});

		const written = await request(
			"PATCH",
			"/preferences",
			{
				latestColor:
				{
					kind: "text",
					color: "red",
				},
			},
		);
		const removed = await request(
			"PATCH",
			"/preferences",
			{
				latestColor: null,
			},
		);

		expect(
			{
				written,
				removed,
				metadata: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				written:
				{
					status: 200,
					body:
					{
						...EMPTY,
						latestColor:
						{
							kind: "text",
							color: "red",
						},
					},
				},
				removed:
				{
					status: 200,
					body: EMPTY,
				},
				metadata: [
					[
						[
							{
								path: ["latestColor"],
								value:
								{
									attribute: 11,
									value: 0,
								},
							},
						],
					],
					[
						[
							{
								path: ["latestColor"],
								value: undefined,
							},
						],
					],
				],
			},
		);
	});

	it("rejects a latestColor outside the palette", async () =>
	{
		const {adapter, request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				latestColor:
				{
					kind: "text",
					color: "magenta",
				},
			},
		);

		expect(
			{
				status: response.status,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				writes: [],
			},
		);
	});

	it("writes searchForChangesAfter as seconds since the join date and removes it with null", async () =>
	{
		const {adapter, request} = setup({});

		const written = await request(
			"PATCH",
			"/preferences",
			{
				searchForChangesAfter: "2017-07-14T02:41:40.900Z",
			},
		);
		const removed = await request(
			"PATCH",
			"/preferences",
			{
				searchForChangesAfter: null,
			},
		);

		expect(
			{
				written,
				removed,
				metadata: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				written:
				{
					status: 200,
					body:
					{
						...EMPTY,
						searchForChangesAfter: "2017-07-14T02:41:40.000Z",
					},
				},
				removed:
				{
					status: 200,
					body: EMPTY,
				},
				metadata: [
					[
						[
							{
								path: ["searchForChangesAfter"],
								value: 100,
							},
						],
					],
					[
						[
							{
								path: ["searchForChangesAfter"],
								value: undefined,
							},
						],
					],
				],
			},
		);
	});

	it("rejects a searchForChangesAfter that is not an ISO date", async () =>
	{
		const {adapter, request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				searchForChangesAfter: "yesterday",
			},
		);

		expect(
			{
				status: response.status,
				writes: adapter.setRootMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				writes: [],
			},
		);
	});

	it("rejects the read-only account field", async () =>
	{
		const {request} = setup({});

		const response = await request(
			"PATCH",
			"/preferences",
			{
				account: null,
			},
		);

		expect(response.status).toBe(400);
	});

	it("rejects unknown keys and mistyped values without writing", async () =>
	{
		const {adapter, request} = setup({});

		const bogus = await request(
			"PATCH",
			"/preferences",
			{
				bogus: 1,
			},
		);
		const mistyped = await request(
			"PATCH",
			"/preferences",
			{
				weekStartDay: "monday",
			},
		);
		const nullFlag = await request(
			"PATCH",
			"/preferences",
			{
				showCompleted: null,
			},
		);

		expect(
			{
				bogus: bogus.status,
				mistyped: mistyped.status,
				nullFlag: nullFlag.status,
				writes: adapter.setRootMetaValues.mock.calls,
				settings: adapter.setSetting.mock.calls,
			},
		).toStrictEqual(
			{
				bogus: 400,
				mistyped: 400,
				nullFlag: 400,
				writes: [],
				settings: [],
			},
		);
	});
});

describe("GET /api/v1/account", () =>
{
	it("returns the user id and ISO join date", async () =>
	{
		const {request} = setup({});

		await expect(request("GET", "/account")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					userId: "42",
					joinedAt: "2017-07-14T02:40:00.000Z",
					fullName: null,
					email: "",
				},
			},
		);
	});

	it("answers a standalone store's provisioned account row, and 503 when it has none", async () =>
	{
		const request = async (ctx: ServerContext) =>
		{
			const res = await httpAppFor(ctx).fetch(new Request("http://x/api/v1/account"));
			return {
				status: res.status,
				body: (await res.json()) as unknown,
			};
		};

		expect(
			{
				provisioned: await request(standaloneContext()),
				unprovisioned: await request(standaloneContext(null)),
			},
		).toStrictEqual(
			{
				provisioned:
				{
					status: 200,
					body:
					{
						userId: "user-a",
						joinedAt: "2023-11-14T22:13:20.000Z",
						fullName: null,
						email: "a@example.com",
					},
				},
				unprovisioned:
				{
					status: 503,
					body:
					{
						error: NOT_CONFIGURED,
					},
				},
			},
		);
	});
});
