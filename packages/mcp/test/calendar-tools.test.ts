import {afterAll, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import {storeInternalMetadata} from "@workflowy/shared/cache";
import {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {callTool, openHarness, seed} from "./harness.js";
import type {Harness} from "./harness.js";

let harness: Harness;

beforeAll(() => {
	harness = openHarness("workflowy-mcp-calendar-test-");
	const {cache} = harness;
	const insert = (id: string, name: string, parentId: string | null, calendar?: unknown) => {
		seed(cache, id, name, parentId);
		if (calendar !== undefined) {
			storeInternalMetadata(harness.db, new Map([[id, {calendar}]]));
		}
	};
	insert("cal", "📆 Calendar", null, {root: true, levels: {year: true, month: true, day: true}});
	insert("y2026", "2026", "cal", {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000});
	insert("m01", "01", "y2026", {level: "month", value: "1", timestamp: 0, dateId: 20_260_100});
	insert("outer", '<time startYear="2026" startMonth="1" startDay="15">Thu, Jan 15, 2026</time>', "m01");
	insert("d14", '<time startYear="2026" startMonth="1" startDay="14">Wed, Jan 14, 2026</time>', "m01", {
		level: "day",
		value: "14",
		timestamp: 0,
		dateId: 20_260_114,
	});
	insert("kid", "Gym", "d14");
});

afterAll(() => {
	harness.restoreEnv();
});

describe("workflowy_calendar_day", () => {
	it("finds a tagged day without calling ensure", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callTool(harness.store, "workflowy_calendar_day", {date: "2026-01-14", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: undefined,
				content: [
					{type: "text", text: JSON.stringify({id: "d14", created: false, firstChildId: "kid"}, null, 2)},
				],
			},
			calls: [],
		});
	});

	it("ensures a missing day through the adapter and returns its result", async () => {
		vi.spyOn(WorkflowyInternalAdapter.prototype, "getEntropyKey").mockResolvedValue(undefined);
		const ensure = vi
			.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay")
			.mockResolvedValue({dayId: "v5day", firstChildId: "kid2", created: ["v5day", "kid2"]});

		const result = await callTool(harness.authStore, "workflowy_calendar_day", {date: "2026-10-22", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: undefined,
				content: [
					{type: "text", text: JSON.stringify({id: "v5day", created: true, firstChildId: "kid2"}, null, 2)},
				],
			},
			calls: [[20_261_022, {stopAt: "day", createChild: true}]],
		});
	});

	it("errors without internal auth and makes no call", async () => {
		const ensure = vi.spyOn(WorkflowyInternalAdapter.prototype, "ensureCalendarDay");

		const result = await callTool(harness.store, "workflowy_calendar_day", {date: "2026-10-22", ensure: true});

		expect({result, calls: ensure.mock.calls}).toStrictEqual({
			result: {
				isError: true,
				content: [
					{
						type: "text",
						text: "Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')",
					},
				],
			},
			calls: [],
		});
	});

	it("treats a name-only day as missing without ensure", async () => {
		const result = await callTool(harness.store, "workflowy_calendar_day", {date: "2026-01-15"});

		expect(result).toStrictEqual({
			isError: true,
			content: [{type: "text", text: "No 📆 Calendar day for 2026-01-15 (pass ensure: true)"}],
		});
	});

	it("rejects a malformed date", async () => {
		const result = await callTool(harness.store, "workflowy_calendar_day", {date: "Jan 15"});

		expect(result).toStrictEqual({
			isError: true,
			content: [{type: "text", text: 'Invalid date "Jan 15". Use YYYY-MM-DD.'}],
		});
	});
});
