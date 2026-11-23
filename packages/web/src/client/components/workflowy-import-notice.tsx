import {memo, useState} from "react";
import {useAuthConfig} from "../auth/auth-config.js";
import {useWorkflowyImportRun} from "../hooks/use-workflowy-connection.js";
import {useOutlineStore} from "../stores/outline.js";
import {failureCount, importProgress, plural} from "../workflowy-import-model.js";
import {ImportProgressBar} from "./workflowy-import-progress.js";

/**
 * The main page's banner for a workflowy.com import: while a run is under way, its phase in plain words and a bar
 * (items, then attachments), above the rows whatever dialog is or is not open, and after a reload, since the run is
 * read from the Worker. Once a run it showed ends, it says how that went until dismissed. Either way it opens the
 * import dialog for the whole picture.
 */
function ImportNotice()
{
	const run = useWorkflowyImportRun();
	const openImportDialog = useOutlineStore((state) => state.openImportDialog);
	const running = run?.status === "running";
	/** The start of the run this banner showed running, so its end is news here; an older run's end is not. */
	const [watched, setWatched] = useState<number | null>(null);
	const [dismissed, setDismissed] = useState<number | null>(null);
	if (run !== null && running && watched !== run.startedAt)
	{
		setWatched(run.startedAt);
	}
	if (run === null || (!running && (watched !== run.startedAt || dismissed === run.startedAt)))
	{
		return null;
	}
	if (running)
	{
		const progress = importProgress(run);
		return (
			<section
				aria-label="Import from workflowy.com"
				className="import-notice mb-m px-m py-s rounded text-s leading-base text-primary print:hidden"
				data-workflowy-import-notice="running"
			>
				<div className="import-notice-row">
					<p aria-live="polite" className="import-notice-text">
						<strong>Importing from workflowy.com.</strong> {progress.label}
						{progress.detail !== null && (
							<span aria-hidden="true" className="text-tertiary">
								{" "}
								{progress.detail}
							</span>
						)}
					</p>
					<button className="import-notice-action" onClick={openImportDialog} type="button">
						View progress
					</button>
				</div>
				<ImportProgressBar progress={progress} />
			</section>
		);
	}
	const problems = failureCount(run);
	const ok = run.status === "ok";
	return (
		<section
			aria-label="Import from workflowy.com"
			className={`import-notice mb-m px-m py-s rounded text-s leading-base text-primary print:hidden${ok && problems === 0 ? "" : " bg-warning"}`}
			data-workflowy-import-notice={run.status}
		>
			<div className="import-notice-row">
				<p aria-live="polite" className="import-notice-text">
					{ok ? (
						<>
							<strong>Import finished.</strong> {plural(run.found.nodes, "item")} from workflowy.com
							{problems > 0 ? `, with ${plural(problems, "problem")} to look at.` : "."}
						</>
					) : (
						<>
							<strong>The import stopped.</strong>{" "}
							{run.status === "expired"
								? "workflowy.com refused the session. Sign in again to carry on."
								: (run.message ?? "unknown error")}
						</>
					)}
				</p>
				<button className="import-notice-action" onClick={openImportDialog} type="button">
					{ok ? "View summary" : "View details"}
				</button>
				<button
					className="import-notice-action"
					onClick={() =>
					{
						setDismissed(run.startedAt);
					}}
					type="button"
				>
					Dismiss
				</button>
			</div>
		</section>
	);
}

/** Only the hosted app has per-account workflowy.com imports; the Node host has no such route to poll. */
export const WorkflowyImportNotice = memo(function WorkflowyImportNotice()
{
	const hosted = useAuthConfig().data?.hosted === true;
	return hosted ? <ImportNotice /> : null;
});
