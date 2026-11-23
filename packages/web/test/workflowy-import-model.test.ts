import {describe, expect, it} from "vite-plus/test";
import type {WorkflowyImportRun} from "../src/node-types.js";
import {importProgress, importStep, progressPercent} from "../src/client/workflowy-import-model.js";

/** A run as `GET /api/v1/workflowy-import` reports it part-way through a large account. */
function run(overrides: Partial<WorkflowyImportRun>): WorkflowyImportRun
{
	return {
		phase: "importing",
		status: "running",
		message: null,
		startedAt: 1,
		finishedAt: null,
		applied: 140_000,
		found:
		{
			nodes: 166_998,
			completed: 3978,
			mirrors: 514,
			backlinks: 150,
			expandedKeys: 32_707,
			stars: 13,
			starOrder: 9,
			tagColors: 399,
			savedViews: 14,
			settings: 18,
		},
		nodes:
		{
			added: 24,
			updated: 500,
			unchanged: 139_476,
			phasedOut: 0,
			metadataWritten: 0,
		},
		failures:
		{
			invalidNodes: 0,
			metadataSkipped: 0,
		},
		files:
		{
			found: 1125,
			copied: 40,
			alreadyCopied: 3,
			failed: 1,
			bytes: 0,
			failures: [],
		},
		...overrides,
	};
}

describe("workflowy.com import model", () =>
{
	it("puts every phase of a running import in plain words, with a count where there is one", () =>
	{
		const phases: Partial<WorkflowyImportRun>[] = [
			{
				phase: "queued",
			},
			{
				phase: "fetching",
			},
			{
				phase: "importing",
				applied: 0,
			},
			{
				phase: "importing",
			},
			{
				phase: "importing",
				applied: 166_998,
			},
			{
				phase: "files",
			},
			{
				phase: "idle",
			},
		];
		expect(
			phases.map((overrides) =>
			{
				const progress = importProgress(run(overrides));
				return [progress.label, progress.detail, progressPercent(progress), progress.stage];
			}),
		).toStrictEqual([
			["Waiting to start", null, null, 0],
			["Downloading your outline from workflowy.com", null, null, 0],
			["Importing items", "0 of 166,998 items", 0, 1],
			["Importing items", "140,000 of 166,998 items", 83, 1],
			["Finishing up: stars, tag colors and settings", "166,998 of 166,998 items", 100, 1],
			["Copying attachments", "44 of 1,125 attachments", 3, 2],
			["Wrapping up", null, null, 2],
		]);
	});

	it("places an account at its step of the flow", () =>
	{
		const connected =
		{
			connected: true,
			status: "connected",
			email: "alice@example.com",
			mirror: false,
			lastSyncAt: null,
		} as const;
		expect([
			importStep(
				{
					connected: false,
				},
				null,
			),
			importStep(
				{
					...connected,
					status: "expired",
				},
				run({}),
			),
			importStep(connected, null),
			importStep(
				connected,
				run(
					{
						status: "expired",
					},
				),
			),
			importStep(connected, run({})),
			importStep(
				connected,
				run(
					{
						status: "error",
					},
				),
			),
			importStep(
				connected,
				run(
					{
						status: "ok",
					},
				),
			),
		]).toStrictEqual(["Connect", "Connect", "Confirm", "Confirm", "Import", "Import", "Done"]);
	});
});
