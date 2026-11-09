import {describe, expect, it, vi} from "vite-plus/test";
import {CalendarRootMissing} from "@outlinedb/shared/internal";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
const ENSURED = {dayId: "day", firstChildId: "child", created: ["month", "day", "child"]};

function setup(
	options: {configured?: boolean; enabled?: boolean; ensure?: WorkflowyInternalAdapter["ensureCalendarDay"]} = {},
) {
	const configured = options.configured ?? true;
	const adapter = {
		ensureCalendarDay: vi.fn<WorkflowyInternalAdapter["ensureCalendarDay"]>(
			options.ensure ?? (async () => Promise.resolve(ENSURED)),
		),
	};
	const ctx = {
		apiKey: configured ? "key" : undefined,
		calendarEnsureEnabled: options.enabled ?? true,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const ensure = async (dateId: string, query = "") => {
		const res = await app.fetch(
			new Request(`http://x/api/v1/calendar/day/${dateId}/ensure${query}`, {method: "POST"}),
		);
		return {status: res.status, body: (await res.json()) as unknown};
	};
	return {adapter, ensure};
}

describe("POST /api/v1/calendar/day/:dateId/ensure", () => {
	it("ensures the day through the adapter and returns its ids", async () => {
		const {adapter, ensure} = setup();

		const response = await ensure("20261017");

		expect({response, calls: adapter.ensureCalendarDay.mock.calls}).toStrictEqual({
			response: {status: 200, body: ENSURED},
			calls: [[20_261_017, {stopAt: "day", createChild: true}]],
		});
	});

	it("passes ?level= as the level to stop at and ?createChild=false through", async () => {
		const {adapter, ensure} = setup();

		const responses = [
			await ensure("20261001", "?level=month&createChild=false"),
			await ensure("20261001", "?level=year"),
			await ensure("20261001", "?level=week"),
			await ensure("20261001", "?level=hour"),
		];

		expect({
			statuses: responses.map(({status}) => status),
			calls: adapter.ensureCalendarDay.mock.calls,
		}).toStrictEqual({
			statuses: [200, 200, 200, 400],
			calls: [
				[20_261_001, {stopAt: "month", createChild: false}],
				[20_261_001, {stopAt: "year", createChild: true}],
				[20_261_001, {stopAt: "week", createChild: true}],
			],
		});
	});

	it("rejects a dateId that is not a real YYYYMMDD day", async () => {
		const {adapter, ensure} = setup();

		const responses = [await ensure("20260230"), await ensure("2026-10-17"), await ensure("202610170")];

		expect({responses, calls: adapter.ensureCalendarDay.mock.calls}).toStrictEqual({
			responses: Array.from({length: 3}, () => ({
				status: 400,
				body: {error: "dateId must be a YYYYMMDD calendar day"},
			})),
			calls: [],
		});
	});

	it("answers 409 when no calendar root is cached", async () => {
		const {ensure} = setup({ensure: async () => Promise.reject(new CalendarRootMissing())});

		await expect(ensure("20261017")).resolves.toStrictEqual({
			status: 409,
			body: {error: new CalendarRootMissing().message},
		});
	});

	it("answers 403 without calling the adapter while ensure is disabled", async () => {
		const {adapter, ensure} = setup({enabled: false});

		const response = await ensure("20261017");

		expect({response, calls: adapter.ensureCalendarDay.mock.calls}).toStrictEqual({
			response: {
				status: 403,
				body: {error: "Calendar day ensure is disabled (CALENDAR_ENSURE_ENABLED=false)"},
			},
			calls: [],
		});
	});

	it("answers 503 without the internal API", async () => {
		const {ensure} = setup({configured: false});

		await expect(ensure("20261017")).resolves.toStrictEqual({status: 503, body: {error: NOT_CONFIGURED}});
	});
});
