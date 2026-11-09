import {storeInternalMetadata} from "@outlinedb/shared/cache";
import {createTestNode} from "./node-fixtures.js";
import {nodeFixtures, seedTestData} from "../db/migration-helper.js";
import type {TestDatabase} from "../db/migration-helper.js";

/** A `<time>` day name, as upstream writes a day. */
function dayTime(year: number, month: number, day: number): string {
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${month}/${day}/${year}</time>`;
}

/**
 * A tagged 📆 Calendar: root > 2026 > 10 with day 2026-10-05 tagged (child `c1`), a name-only day 2026-10-06 with
 * a child, and a month-level meeting row that mentions Oct 5 with a time.
 */
export function seedTaggedCalendar(testDatabase: TestDatabase): void {
	seedTestData(testDatabase, {
		...nodeFixtures([
			createTestNode({id: "cal", name: "📆 Calendar", parentId: null}),
			createTestNode({id: "y2026", name: "2026", parentId: "cal"}),
			createTestNode({id: "m10", name: "10", parentId: "y2026"}),
			createTestNode({
				id: "meeting",
				name: '<time startYear="2026" startMonth="10" startDay="5" startHour="10">Mon, Oct 5, 2026 10:00</time> #meeting',
				parentId: "m10",
				priority: 0,
			}),
			createTestNode({id: "d1005", name: dayTime(2026, 10, 5), parentId: "m10", priority: 100}),
			createTestNode({id: "c1", name: "Dentist", parentId: "d1005", priority: 0}),
			createTestNode({id: "d1006", name: dayTime(2026, 10, 6), parentId: "m10", priority: 200}),
			createTestNode({id: "c2", name: "Gym", parentId: "d1006", priority: 0}),
			createTestNode({id: "stray", name: dayTime(2026, 10, 21), parentId: null, priority: 500}),
		]),
	});
	const metadata: [string, Record<string, unknown>][] = [
		["cal", {calendar: {root: true, levels: {year: true, month: true, day: true}}}],
		["y2026", {calendar: {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000}}],
		["m10", {calendar: {level: "month", value: "10", timestamp: 0, dateId: 20_261_000}}],
		["d1005", {calendar: {level: "day", value: "5", timestamp: 0, dateId: 20_261_005}}],
	];
	storeInternalMetadata(testDatabase.db, new Map(metadata));
}
