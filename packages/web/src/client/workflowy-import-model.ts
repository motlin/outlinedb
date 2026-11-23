/**
 * Pure wording and arithmetic for a workflowy.com import run: which step of the import flow an account is at, the
 * running phase in plain words with its progress, and what the run found and brought over, as labelled numbers.
 */

import type {WorkflowyConnection, WorkflowyImportRun} from "../node-types.js";

export function plural(count: number, one: string, many = `${one}s`): string
{
	return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function formatBytes(bytes: number): string
{
	if (bytes < 1024)
	{
		return plural(bytes, "byte");
	}
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1)
	{
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** The import flow's steps, in order. */
export const IMPORT_STEPS = ["Connect", "Confirm", "Import", "Done"] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

/**
 * Where the account is in the flow. A run that a refused session stopped imported nothing, so once the account is
 * signed in again it is back at Confirm; a failed run stays at Import, where it can be tried again.
 */
export function importStep(connection: WorkflowyConnection, run: WorkflowyImportRun | null): ImportStep
{
	if (!connection.connected || connection.status === "expired")
	{
		return "Connect";
	}
	if (run === null || run.status === "expired")
	{
		return "Confirm";
	}
	return run.status === "ok" ? "Done" : "Import";
}

/** The stages a running import goes through, in order. */
export const IMPORT_STAGES = ["Download your outline", "Import items", "Copy attachments"] as const;

export interface ImportProgress
{
	/** The phase in plain words; changes only when the phase does, so it can be announced. */
	label: string;
	/** The count under way, as "140,000 of 166,998 items"; null for a phase with nothing to count. */
	detail: string | null;
	done: number;
	/** 0 when the phase has nothing to count: the bar shows activity, not a fraction. */
	total: number;
	/** Index into {@link IMPORT_STAGES} of the stage under way. */
	stage: number;
}

/** A phase with nothing to count. */
function uncounted(label: string, stage: number): ImportProgress
{
	return {
		label,
		detail: null,
		done: 0,
		total: 0,
		stage,
	};
}

/** A running import's phase and progress. Every phase the Worker reports has its own words. */
export function importProgress(run: WorkflowyImportRun): ImportProgress
{
	if (run.phase === "queued")
	{
		return uncounted("Waiting to start", 0);
	}
	if (run.phase === "fetching")
	{
		return uncounted("Downloading your outline from workflowy.com", 0);
	}
	if (run.phase === "importing")
	{
		const total = run.found.nodes;
		// Every item is in; what is left is one pass writing stars, tag colors, saved views and settings.
		if (total > 0 && run.applied >= total)
		{
			return {
				label: "Finishing up: stars, tag colors and settings",
				detail: `${total.toLocaleString()} of ${plural(total, "item")}`,
				done: total,
				total,
				stage: 1,
			};
		}
		return {
			label: "Importing items",
			detail: `${run.applied.toLocaleString()} of ${plural(total, "item")}`,
			done: run.applied,
			total,
			stage: 1,
		};
	}
	if (run.phase === "files")
	{
		const total = run.files.found;
		const done = run.files.copied + run.files.alreadyCopied + run.files.failed;
		return {
			label: "Copying attachments",
			detail: `${done.toLocaleString()} of ${plural(total, "attachment")}`,
			done,
			total,
			stage: 2,
		};
	}
	return uncounted("Wrapping up", 2);
}

/** A progress fraction as a whole percent, clamped; null when there is nothing to count. */
export function progressPercent(progress: Pick<ImportProgress, "done" | "total">): number | null
{
	if (progress.total <= 0)
	{
		return null;
	}
	return Math.min(100, Math.max(0, Math.floor((progress.done / progress.total) * 100)));
}

export interface ImportStat
{
	label: string;
	value: string;
}

/** True once the run has read the outline, so its found counts mean something. */
export function hasFound(run: WorkflowyImportRun): boolean
{
	return run.phase !== "queued" && run.phase !== "fetching" && run.status !== "expired";
}

/** The few numbers worth reading first: the items always, the other kinds only when the run found some. */
export function foundHeadlines(run: WorkflowyImportRun): ImportStat[]
{
	const kinds: [number, string][] = [
		[run.found.completed, "Completed"],
		[run.found.mirrors, "Mirrors"],
		[run.files.found, "Attachments"],
	];
	return [
		{
			label: "Items",
			value: run.found.nodes.toLocaleString(),
		},
		...kinds
			.filter(([count]) => count > 0)
			.map(([count, label]) => (
			{
				label,
				value: count.toLocaleString(),
			})),
	];
}

/** Everything else the run found, for the expandable list; kinds it found none of are left out. */
export function foundDetails(run: WorkflowyImportRun): ImportStat[]
{
	const kinds: [number, string][] = [
		[run.found.backlinks, "Backlinks"],
		[run.found.stars, "Stars"],
		[run.found.tagColors, "Tag colors"],
		[run.found.savedViews, "Saved views"],
		[run.found.settings, "Settings"],
		[run.found.expandedKeys, "Expanded items"],
	];
	return kinds
		.filter(([count]) => count > 0)
		.map(([count, label]) => (
		{
			label,
			value: count.toLocaleString(),
		}));
}

/** What a finished run brought over, as the few numbers worth reading first. */
export function importedHeadlines(run: WorkflowyImportRun): ImportStat[]
{
	const {nodes, files, found} = run;
	const stats: ImportStat[] = [
		{
			label: "Items",
			value: (nodes.added + nodes.updated + nodes.unchanged).toLocaleString(),
		},
	];
	if (found.completed > 0)
	{
		stats.push(
			{
				label: "Completed",
				value: found.completed.toLocaleString(),
			},
		);
	}
	if (found.mirrors > 0)
	{
		stats.push(
			{
				label: "Mirrors",
				value: found.mirrors.toLocaleString(),
			},
		);
	}
	if (files.found > 0)
	{
		stats.push(
			{
				label: `Attachments of ${files.found.toLocaleString()}`,
				value: (files.copied + files.alreadyCopied).toLocaleString(),
			},
		);
	}
	return stats;
}

/** What a finished run did with the items and the attachments, one line each. */
export function resultLines(run: WorkflowyImportRun): string[]
{
	const {nodes, files} = run;
	const lines = [
		`Items: ${nodes.added.toLocaleString()} added, ${nodes.updated.toLocaleString()} updated, ${nodes.unchanged.toLocaleString()} unchanged, ${nodes.phasedOut.toLocaleString()} removed`,
	];
	if (files.found > 0)
	{
		lines.push(
			`Attachments: ${files.copied.toLocaleString()} copied (${formatBytes(files.bytes)}), ${files.alreadyCopied.toLocaleString()} already copied, ${files.failed.toLocaleString()} failed`,
		);
	}
	return lines;
}

/** What this run left out or could not copy, in counts. */
export function failureCount(run: WorkflowyImportRun): number
{
	return run.failures.invalidNodes + run.failures.metadataSkipped + run.files.failed;
}
