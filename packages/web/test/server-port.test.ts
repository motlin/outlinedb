import {describe, expect, it} from "vite-plus/test";
import {DEFAULT_PORT, resolvePort} from "../src/server/port.js";

describe("resolvePort", () =>
{
	it("defaults to a port no sibling project claims, so dev never lands on the crowded 3000", () =>
	{
		expect(DEFAULT_PORT).toBe(5176);
		expect(resolvePort({})).toBe(5176);
	});

	it("honours PORT so a second instance can run beside a running dev server", () =>
	{
		expect(
			resolvePort(
				{
					PORT: "3010",
				},
			),
		).toBe(3010);
	});

	it("falls back to the default when PORT is empty or not a number", () =>
	{
		expect(
			resolvePort(
				{
					PORT: "",
				},
			),
		).toBe(5176);
		expect(
			resolvePort(
				{
					PORT: "nope",
				},
			),
		).toBe(5176);
	});
});
