import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	CacheService,
	LocalAccount,
	readAccountSnapshot,
	readPendingAccountOutbox,
	readPendingOutbox,
	runUnitOfWork,
	storeInternalMetadata,
	writeAccountSnapshot,
} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {standaloneContext} from "./helpers/local-context.js";
import {httpAppFor} from "./http-app-for.js";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";

describe("preferences route", () =>
{
	const NOT_CONFIGURED =
		"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
	type MetadataChange = Parameters<WorkflowyInternalAdapter["setRootMetaValues"]>[0][number];

	const NOTES = "1a2b3c4d-0000-4000-8000-000000000001";

	function isRecord(value: unknown): value is Record<string, unknown>
	{
		return typeof value === "object" && value !== null;
	}

	/**
	 * A mirror whose account tables hold `meta` and `settings` (none, and no internal API, when `meta` is undefined).
	 * workflowy.com is down: an account write that pushed first would fail, so every write must land locally with an
	 * account outbox row.
	 */
	function setup(meta: Record<string, unknown> | undefined, settings: Record<string, unknown> = {})
	{
		const unreachable = async () => Promise.reject(new Error("workflowy.com is unreachable"));
		const adapter =
		{
			loadAccountState: vi.fn<WorkflowyInternalAdapter["loadAccountState"]>(async () => Promise.resolve()),
			setSetting: vi.fn<WorkflowyInternalAdapter["setSetting"]>(unreachable),
			setRootMetaValues: vi.fn<WorkflowyInternalAdapter["setRootMetaValues"]>(unreachable),
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
		if (meta !== undefined)
		{
			runUnitOfWork(db, (unitOfWork) =>
			{
				writeAccountSnapshot(
					unitOfWork,
					{
						account:
						{
							userId: "42",
							dateJoinedSec: 1_500_000_000,
						},
						rootMetadata: meta,
						settings,
						visibleFeatures: [],
					},
				);
			});
		}
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
		const stored = () => readAccountSnapshot(db);
		const pending = (subject: string) => readPendingAccountOutbox(db).filter((row) => row.subject === subject);
		/** What the account outbox would deliver: each pending root metadata path and its local value. */
		const local =
		{
			pendingRoot: () =>
				pending("root_metadata").map(({key}) =>
				{
					const path = key.split("\u001F");
					return {
						path,
						value: path.reduce<unknown>(
							(value, segment) => (isRecord(value) ? value[segment] : undefined),
							stored()?.rootMetadata,
						),
					};
				}),
			/** Each pending setting and its local value. */
			pendingSettings: () => pending("setting").map(({key}) => [key, stored()?.settings[key]]),
			rootMeta: () => stored()?.rootMetadata,
		};
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
			local,
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
			const {local, request} = setup(
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
					settings: local.pendingSettings(),
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
			const {local, request} = setup(
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
					settings: local.pendingSettings(),
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
			const {local, request} = setup(
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
					settings: local.pendingSettings(),
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
					settings: on.local.pendingSettings(),
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

		it("answers changelog.read as changelogRead, and null when the account has none", async () =>
		{
			const read = setup(
				{
					changelog:
					{
						read:
						{
							may27_2025: true,
							june11_2025: false,
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
			const {local, request} = setup(
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
					writes: local.pendingRoot(),
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
						{
							path: ["dateFormat"],
							value: "YYYY-MM-DD ddd",
						},
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
			const {local, request} = setup(meta);

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
					writes: local.pendingRoot(),
					meta: local.rootMeta(),
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
						{
							path: ["calendar", "tooltip_seen"],
							value: true,
						},
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
			const {local, request} = setup(meta);

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
					writes: local.pendingRoot(),
					meta: local.rootMeta(),
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
						{
							path: ["emoji", "options", "selected"],
							value: "noto",
						},
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
			const {local, request} = setup(meta);

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
					writes: local.pendingRoot(),
					meta: local.rootMeta(),
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
						{
							path: ["ai", "embeddingStatus"],
							value: "requested",
						},
						{
							path: ["ai", "embedding_tooltip_dismissed"],
							value: true,
						},
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
			const {local, request} = setup({});

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
					writes: local.pendingRoot(),
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
						{
							path: ["slash", "discovered"],
							value: true,
						},
					],
				},
			);
		});

		it("writes several fields and removes a field set to null, each pending for the outbox", async () =>
		{
			const {local, request} = setup(
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
					writes: local.pendingRoot(),
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
						{
							path: ["notesRootId"],
							value: undefined,
						},
						{
							path: ["weekStartDay"],
							value: 0,
						},
					],
				},
			);
		});

		it("rejects a changelogRead patch without writing, since upstream's changelog.read is read-only here", async () =>
		{
			const {local, request} = setup(
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
					writes: local.pendingRoot(),
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
			const {local, request} = setup(
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
					settings: local.pendingSettings(),
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
			const {local, request} = setup(
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
					settings: local.pendingSettings(),
					metadata: local.pendingRoot(),
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
			const {local, request} = setup({});

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
					settings: local.pendingSettings(),
					metadata: local.pendingRoot(),
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
						{
							path: ["dateFormat"],
							value: "MMM D",
						},
					],
				},
			);
		});

		it("writes ignoreLoom through the account settings and weeklyReportOn at weekly-report.on", async () =>
		{
			const {local, request} = setup({});

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
					settings: local.pendingSettings(),
					metadata: local.pendingRoot(),
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
						{
							path: ["weekly-report", "on"],
							value: true,
						},
					],
				},
			);
		});

		it("writes latestColor as upstream's {attribute, value} and removes it with null", async () =>
		{
			const {local, request} = setup({});

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
			const pendingAfterWrite = local.pendingRoot();
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
					pendingAfterWrite,
					pendingAfterRemove: local.pendingRoot(),
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
					pendingAfterWrite: [
						{
							path: ["latestColor"],
							value:
							{
								attribute: 11,
								value: 0,
							},
						},
					],
					// The removal coalesces into the same pending row, which now delivers the removal.
					pendingAfterRemove: [
						{
							path: ["latestColor"],
							value: undefined,
						},
					],
				},
			);
		});

		it("rejects a latestColor outside the palette", async () =>
		{
			const {local, request} = setup({});

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
					writes: local.pendingRoot(),
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
			const {local, request} = setup({});

			const written = await request(
				"PATCH",
				"/preferences",
				{
					searchForChangesAfter: "2017-07-14T02:41:40.900Z",
				},
			);
			const pendingAfterWrite = local.pendingRoot();
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
					pendingAfterWrite,
					pendingAfterRemove: local.pendingRoot(),
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
					pendingAfterWrite: [
						{
							path: ["searchForChangesAfter"],
							value: 100,
						},
					],
					// The removal coalesces into the same pending row, which now delivers the removal.
					pendingAfterRemove: [
						{
							path: ["searchForChangesAfter"],
							value: undefined,
						},
					],
				},
			);
		});

		it("rejects a searchForChangesAfter that is not an ISO date", async () =>
		{
			const {local, request} = setup({});

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
					writes: local.pendingRoot(),
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
			const {local, request} = setup({});

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
					writes: local.pendingRoot(),
					settings: local.pendingSettings(),
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
});

describe("preferences week layout", () =>
{
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	const open: DatabaseConstructor.Database[] = [];
	afterEach(() =>
	{
		for (const sqlite of open.splice(0))
		{
			sqlite.close();
		}
	});

	function app(
		levels: Record<string, boolean>,
		{
			layoutEnabled,
			weekStartDay,
		}:
		{
			layoutEnabled?: boolean;
			weekStartDay?: number;
		} = {},
	)
	{
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		migrate(
			db,
			{
				migrationsFolder,
			},
		);
		// September 10, 2026 under its year and month, but in no week node yet.
		for (const [id, parentId, name] of [
			["cal", null, "📆 Calendar"],
			["y2026", "cal", "2026"],
			["m09", "y2026", "9"],
			["d0910", "m09", "Thu, Sep 10, 2026"],
		] as const)
		{
			db.insert(schema.nodeContent)
				.values(
					{
						id,
						name,
						parentId,
						systemFrom: "2026-01-01",
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
		}
		storeInternalMetadata(
			db,
			new Map<string, Record<string, unknown>>([
				[
					"cal",
					{
						calendar:
						{
							root: true,
							levels,
						},
					},
				],
				[
					"y2026",
					{
						calendar:
						{
							level: "year",
							value: "2026",
							timestamp: 0,
							dateId: 20_260_000,
						},
					},
				],
				[
					"m09",
					{
						calendar:
						{
							level: "month",
							value: "9",
							timestamp: 0,
							dateId: 20_260_900,
						},
					},
				],
				[
					"d0910",
					{
						calendar:
						{
							level: "day",
							value: "10",
							timestamp: 0,
							dateId: 20_260_910,
						},
					},
				],
			]),
		);
		const meta: Record<string, unknown> =
			weekStartDay === undefined
				? {}
				:
					{
						weekStartDay,
					};
		runUnitOfWork(db, (unitOfWork) =>
		{
			writeAccountSnapshot(
				unitOfWork,
				{
					account:
					{
						userId: "42",
						dateJoinedSec: 1_500_000_000,
					},
					rootMetadata: meta,
					settings: {},
					visibleFeatures: [],
				},
			);
		});
		const adapter =
		{
			loadAccountState: async () => Promise.resolve(),
			// The real adapter reads root metadata from the same local account tables the PATCH writes.
			getRootMeta: async (path: string[]) => new LocalAccount(db).getRootMeta(path),
			getEntropyKey: async () => Promise.resolve("k"),
			// workflowy.com is down: a tree write that reached it would fail.
			applyCalendarLayout: async () => Promise.reject(new Error("workflowy.com is unreachable")),
		};
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
			apiKey: "key",
			calendarLayoutEnabled: layoutEnabled,
			outboxWritten: () =>
			{
				// The drain is the host's; these tests read the pending rows it would deliver.
			},
			internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
		} as unknown as ServerContext;
		const hono = httpAppFor(ctx);
		const patch = async (body: unknown) =>
			hono.fetch(
				new Request(
					"http://x/api/v1/preferences",
					{
						method: "PATCH",
						headers:
						{
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					},
				),
			);
		/** The local re-layout's pending outbox rows, as `node aspect`. */
		const relaid = () => readPendingOutbox(db, 100).map(({nodeId, aspect}) => `${nodeId} ${aspect}`);
		return {
			patch,
			relaid,
		};
	}

	describe("PATCH /api/v1/preferences weekStartDay", () =>
	{
		it("re-applies the current layout locally when the week start changes under a week-level calendar", async () =>
		{
			const {patch, relaid} = app(
				{
					year: true,
					month: true,
					week: true,
					day: true,
				},
			);
			await patch(
				{
					weekStartDay: 1,
				},
			);
			// The day moves into a new week node with the account's deterministic id for its Monday-start week.
			const week = "1b217167-b3bd-572f-a004-3c3bc8adab70";
			expect(relaid()).toStrictEqual([`${week} create`, `${week} placement`, "d0910 placement"]);
		});

		it("does not re-layout when the calendar has no week level", async () =>
		{
			const {patch, relaid} = app(
				{
					year: true,
					month: true,
					day: true,
				},
			);
			await patch(
				{
					weekStartDay: 1,
				},
			);
			expect(relaid()).toStrictEqual([]);
		});

		it("does not re-layout when the week start is unchanged", async () =>
		{
			const {patch, relaid} = app(
				{
					year: true,
					week: true,
					day: true,
				},
				{
					weekStartDay: 1,
				},
			);
			await patch(
				{
					weekStartDay: 1,
				},
			);
			expect(relaid()).toStrictEqual([]);
		});

		it("does not re-layout when applying layouts is disabled", async () =>
		{
			const {patch, relaid} = app(
				{
					year: true,
					week: true,
					day: true,
				},
				{
					layoutEnabled: false,
				},
			);
			await patch(
				{
					weekStartDay: 1,
				},
			);
			expect(relaid()).toStrictEqual([]);
		});

		it("does not re-layout for other preferences", async () =>
		{
			const {patch, relaid} = app(
				{
					year: true,
					week: true,
					day: true,
				},
			);
			await patch(
				{
					dateFormat: "YYYY-MM-DD",
				},
			);
			expect(relaid()).toStrictEqual([]);
		});
	});
});
