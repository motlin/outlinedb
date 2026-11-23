import type {ImportProgress, ImportStat} from "../workflowy-import-model.js";
import {progressPercent} from "../workflowy-import-model.js";

/**
 * A running import's bar: a fraction of the items, then of the attachments, and a moving stripe for a phase with
 * nothing to count. Named by its phase for a screen reader, with the count as its value text.
 */
export function ImportProgressBar({progress}: {progress: ImportProgress})
{
	const counted = progressPercent(progress) !== null;
	return (
		<progress
			aria-label={progress.label}
			aria-valuetext={progress.detail ?? undefined}
			className="import-progress"
			max={counted ? progress.total : undefined}
			value={counted ? progress.done : undefined}
		/>
	);
}

/** Labelled numbers as a row of tiles. */
export function ImportStats({stats}: {stats: ImportStat[]})
{
	return (
		<dl className="import-stats">
			{stats.map((stat) => (
				<div className="import-stat" key={stat.label}>
					<dt className="text-s leading-xs text-tertiary">{stat.label}</dt>
					<dd className="text-l leading-xs font-bold text-primary">{stat.value}</dd>
				</div>
			))}
		</dl>
	);
}
