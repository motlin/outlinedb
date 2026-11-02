import {describe, expect, it} from "vite-plus/test";
import {CALENDAR_ID_NAMESPACE, calendarNodeId, uuidv5} from "../src/internal/calendar-ids.js";

// Expected values computed independently with Python's `uuid.uuid5`.
describe("uuidv5", () =>
{
	it("matches the RFC 4122 DNS-namespace example", () =>
	{
		expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
			"2ed6657d-e927-568b-95e1-2665a8aea6a2",
		);
	});
});

describe("calendarNodeId", () =>
{
	it("is the uuidv5 of `${entropyKey}-calendar-${level}-${dateId}` in upstream's namespace", () =>
	{
		expect(CALENDAR_ID_NAMESPACE).toBe("3e19dffe-1c3b-4d76-8e57-0de20e69bdae");
		expect(calendarNodeId("k", "day", 20_261_017)).toBe("e7a88667-b0da-5b51-b5ca-0da96853dc1e");
		expect(calendarNodeId("k", "month", 20_261_000)).toBe("fec3b740-fe77-561b-a470-4abe9b1ecd66");
	});

	it("names a week `calendar-week-${year}-${dateId}`, the year being the date's, not the week start's", () =>
	{
		expect([
			calendarNodeId("k", "week", 20_261_011, 2026),
			calendarNodeId("k", "week", 20_261_227, 2027),
		]).toStrictEqual(["230a80db-d497-5344-89bd-f6bf3274ddf1", "f3ea7c80-7d8d-5b92-980e-6db0ea8914d5"]);
	});
});
