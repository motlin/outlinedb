import {describe, expect, test} from "vite-plus/test";
import {findOverruns, summarizeUsage, treeDownloadCount} from "./cloudflare-usage-alert.mjs";

/** @type {import("./cloudflare-usage-alert.mjs").Budgets} */
const budgets =
{
	doRowsRead: 1000,
	doRowsWritten: 100,
	doRequests: 50,
	doErrors: 0,
	doCpuMs: 10,
	workerRequests: 50,
	workerErrors: 1,
	workerCpuMs: 10,
	treeDownloads: 2,
};

describe("cloudflare usage alert", () =>
{
	test("summarizeUsage totals one script's day, merging each Durable Object's storage and invocation rows", () =>
	{
		const summary = summarizeUsage(
			{
				periodic: [
					{
						dimensions:
						{
							namespaceId: "ns1",
							objectId: "a",
						},
						sum:
						{
							rowsRead: 900,
							rowsWritten: 40,
							cpuTime: 6000,
						},
					},
					{
						dimensions:
						{
							namespaceId: "ns2",
							objectId: "b",
						},
						sum:
						{
							rowsRead: 5,
							rowsWritten: 1,
							cpuTime: 500,
						},
					},
				],
				invocations: [
					{
						dimensions:
						{
							namespaceId: "ns1",
							objectId: "a",
							scriptName: "outlinedb",
						},
						sum:
						{
							requests: 30,
							errors: 1,
						},
					},
					{
						dimensions:
						{
							namespaceId: "ns3",
							objectId: "c",
							scriptName: "other",
						},
						sum:
						{
							requests: 2,
							errors: 0,
						},
					},
				],
				workers: [
					{
						dimensions:
						{
							scriptName: "outlinedb",
							status: "success",
						},
						sum:
						{
							requests: 60,
							errors: 0,
							cpuTimeUs: 8000,
						},
					},
					{
						dimensions:
						{
							scriptName: "outlinedb",
							status: "scriptThrewException",
						},
						sum:
						{
							requests: 2,
							errors: 2,
							cpuTimeUs: 4000,
						},
					},
					{
						dimensions:
						{
							scriptName: "other",
							status: "success",
						},
						sum:
						{
							requests: 500,
							errors: 5,
							cpuTimeUs: 9000,
						},
					},
				],
			},
			"outlinedb",
			3,
		);
		// ns2 has storage rows but no outlinedb invocation, and ns3 belongs to another script, so neither counts.
		expect(summary).toStrictEqual(
			{
				totals:
				{
					doRowsRead: 900,
					doRowsWritten: 40,
					doRequests: 30,
					doErrors: 1,
					doCpuMs: 6,
					workerRequests: 62,
					workerErrors: 2,
					workerCpuMs: 12,
					treeDownloads: 3,
				},
				objects: [
					{
						namespaceId: "ns1",
						objectId: "a",
						rowsRead: 900,
						rowsWritten: 40,
						cpuMs: 6,
						requests: 30,
						errors: 1,
					},
				],
			},
		);

		// A metric at its budget is fine; only one above it is an overrun.
		expect(findOverruns(summary.totals, budgets)).toStrictEqual([
			{
				metric: "doErrors",
				value: 1,
				budget: 0,
			},
			{
				metric: "workerRequests",
				value: 62,
				budget: 50,
			},
			{
				metric: "workerErrors",
				value: 2,
				budget: 1,
			},
			{
				metric: "workerCpuMs",
				value: 12,
				budget: 10,
			},
			{
				metric: "treeDownloads",
				value: 3,
				budget: 2,
			},
		]);
		expect(
			findOverruns(
				{
					...summary.totals,
					doErrors: 0,
					workerRequests: 50,
					workerErrors: 1,
					workerCpuMs: 10,
					treeDownloads: 2,
				},
				budgets,
			),
		).toStrictEqual([]);
	});

	test("treeDownloadCount reads the day's sampled sum, and zero before the dataset's first write", () =>
	{
		expect([
			treeDownloadCount(
				true,
				{
					data: [
						{
							downloads: "4",
						},
					],
				},
			),
			treeDownloadCount(
				true,
				{
					data: [
						{
							downloads: null,
						},
					],
				},
			),
			treeDownloadCount(false, "Table outlinedb_tree_downloads does not exist"),
		]).toStrictEqual([4, 0, 0]);
		expect(() => treeDownloadCount(false, "Authentication error")).toThrow(
			"Analytics Engine query failed: Authentication error",
		);
	});
});
