import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {toRequestStatusError} from "../src/client/request-error.js";

describe("toRequestStatusError", () =>
{
	it("uses the server's error body and keeps the status", async () =>
	{
		const e = await toRequestStatusError(
			"Failed to create node",
			Response.json(
				{
					error: "name is required",
				},
				{
					status: 400,
					statusText: "Bad Request",
				},
			),
		);
		expect(
			{
				name: e.name,
				status: e.status,
				message: e.message,
			},
		).toStrictEqual(
			{
				name: "RequestStatusError",
				status: 400,
				message: "Failed to create node: name is required",
			},
		);
	});

	it("falls back to the status text for a non-JSON body", async () =>
	{
		const e = await toRequestStatusError(
			"Failed to create node",
			new Response(
				"<html>",
				{
					status: 502,
					statusText: "Bad Gateway",
				},
			),
		);
		expect(
			{
				status: e.status,
				message: e.message,
			},
		).toStrictEqual(
			{
				status: 502,
				message: "Failed to create node: Bad Gateway",
			},
		);
	});

	it("use-nodes.ts throws no plain Error for a failed response", () =>
	{
		const source = readFileSync(new URL("../src/client/hooks/use-nodes.ts", import.meta.url), "utf8");
		expect(source.match(/throw new Error\(`Failed to/gu)).toBeNull();
	});
});
