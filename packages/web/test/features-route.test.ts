import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it, vi} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {DEFAULT_FEATURES, VISIBLE_FEATURES} from "../src/feature-catalog.js";
import upstreamFeatures from "./fixtures/upstream-settings-features.json" with {type: "json"};
import {httpAppFor} from "./http-app-for.js";

const VISIBLE = [
	{codename: "beta_redirect", name: "Workflowy Labs", label: null, description: "a"},
	{codename: "dates", name: "Dates", label: null, description: null},
	{codename: "dashboards", name: "Dashboard layout", label: "LABS", description: "c"},
];

function setup(withAdapter: boolean) {
	const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
	migrate(db, {migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations")});
	const adapter = {
		visibleFeatures: vi.fn<WorkflowyInternalAdapter["visibleFeatures"]>(async () => Promise.resolve(VISIBLE)),
		enabledFeatures: vi.fn<WorkflowyInternalAdapter["enabledFeatures"]>(async () => Promise.resolve({dates: true})),
		setFeature: vi.fn<WorkflowyInternalAdapter["setFeature"]>(async () =>
			Promise.resolve({dates: true, beta_redirect: true}),
		),
	};
	const ctx = {
		db,
		mode: withAdapter ? "mirror" : "standalone",
		internalAdapter: () => (withAdapter ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const request = async (method: string, path: string, body?: unknown) => {
		const res = await app.fetch(
			new Request(`http://x/api/v1/features${path}`, {
				method,
				headers: {"content-type": "application/json"},
				...(body === undefined ? {} : {body: JSON.stringify(body)}),
			}),
		);
		return {status: res.status, body: (await res.json()) as unknown};
	};
	return {adapter, db, request};
}

describe("feature catalog", () => {
	it("matches upstream's measured Settings rows renamed to OutlineDB, and its defaults drop only the hidden check, slash-command and trash", () => {
		const {check: _check, "slash-command": _slash, trash: _trash, ...visibleDefaults} = upstreamFeatures.enabled;
		const rebrand = (text: string | null) => text?.replaceAll(/WorkFlowy|Workflowy/gu, "OutlineDB") ?? null;
		expect({visible: VISIBLE_FEATURES, enabled: DEFAULT_FEATURES}).toStrictEqual({
			visible: upstreamFeatures.visible.map((feature) => ({
				...feature,
				name: rebrand(feature.name),
				description: rebrand(feature.description),
			})),
			enabled: visibleDefaults,
		});
	});
});

describe("/api/v1/features", () => {
	it("GET answers the visible list and enabled dict from the adapter", async () => {
		const {request} = setup(true);

		await expect(request("GET", "")).resolves.toStrictEqual({
			status: 200,
			body: {visible: VISIBLE, enabled: {dates: true}, available: true},
		});
	});

	it("GET without the adapter answers the enabled flags stored in enabled_features", async () => {
		const {request, db} = setup(false);
		const live = {systemFrom: "2026-01-01 00:00:00.000", systemTo: "9999-12-31 23:59:59"};
		db.insert(schema.enabledFeatures)
			.values([
				{codename: "table", enabled: 1, ...live},
				{codename: "dates", enabled: 0, ...live},
				{codename: "old", enabled: 1, systemFrom: "2025-01-01 00:00:00.000", systemTo: live.systemFrom},
			])
			.run();

		await expect(request("GET", "")).resolves.toStrictEqual({
			status: 200,
			body: {visible: VISIBLE_FEATURES, enabled: {table: true}, available: false},
		});
	});

	it("GET without the adapter or a durable copy answers the default dict and the visible catalog", async () => {
		const {request} = setup(false);

		await expect(request("GET", "")).resolves.toStrictEqual({
			status: 200,
			body: {visible: VISIBLE_FEATURES, enabled: DEFAULT_FEATURES, available: false},
		});
	});

	it("POST toggles through the adapter and returns its dict", async () => {
		const {request, adapter} = setup(true);

		await expect(request("POST", "/beta_redirect", {on: true})).resolves.toStrictEqual({
			status: 200,
			body: {enabled: {dates: true, beta_redirect: true}},
		});
		expect(adapter.setFeature.mock.calls).toStrictEqual([["beta_redirect", true]]);
	});

	it("POST rejects a bad body or codename with 400 and writes nothing", async () => {
		const {request, adapter} = setup(true);

		expect((await request("POST", "/x", {on: "yes"})).status).toBe(400);
		expect((await request("POST", "/x", {on: true, extra: 1})).status).toBe(400);
		expect((await request("POST", "/Bad.Name", {on: true})).status).toBe(400);
		expect(adapter.setFeature).not.toHaveBeenCalled();
	});

	it("POST without the adapter persists the toggle locally on top of the defaults", async () => {
		const {request} = setup(false);
		const {dates: _dates, ...withoutDates} = DEFAULT_FEATURES;

		const off = await request("POST", "/dates", {on: false});
		const on = await request("POST", "/dashboards", {on: true});
		const after = await request("GET", "");

		expect({off, on, after}).toStrictEqual({
			off: {status: 200, body: {enabled: withoutDates}},
			on: {status: 200, body: {enabled: {...withoutDates, dashboards: true}}},
			after: {
				status: 200,
				body: {visible: VISIBLE_FEATURES, enabled: {...withoutDates, dashboards: true}, available: false},
			},
		});
	});
});
