/**
 * The import-from-workflowy.com dialog: the whole flow in one place, a step at a time. Connect signs in, Confirm says
 * what the import replaces and starts it, Import shows the live run, and Done says what came over, what did not, and
 * whether the two outlines keep syncing. Opened from the signup wizard, the outline's import banner and Settings.
 */

import {useState} from "react";
import type {ReactNode} from "react";
import {requestErrorMessage, useWorkflowyConnection} from "../hooks/use-workflowy-connection.js";
import type {WorkflowyConnection, WorkflowyImportRun} from "../../node-types.js";
import {useOutlineStore} from "../stores/outline.js";
import
{
	IMPORT_STAGES,
	IMPORT_STEPS,
	failureCount,
	foundDetails,
	foundHeadlines,
	hasFound,
	importProgress,
	importStep,
	importedHeadlines,
	plural,
	resultLines,
} from "../workflowy-import-model.js";
import type {ImportStep} from "../workflowy-import-model.js";
import {DialogCloseButton, DialogShell} from "./dialog-shell.js";
import {ControlRow, SettingsButton} from "./settings-rows.js";
import {Toggle} from "./toggle.js";
import {ImportProgressBar, ImportStats} from "./workflowy-import-progress.js";
import {Alert, Hint, SignInForm} from "./workflowy-login-form.js";

type Connected = Extract<
	WorkflowyConnection,
	{
		connected: true;
	}
>;

/** The flow's steps, with the ones behind the current step checked off. */
function Steps({current}: {current: ImportStep})
{
	const at = IMPORT_STEPS.indexOf(current);
	return (
		<ol aria-label="Import steps" className="import-steps">
			{IMPORT_STEPS.map((step, index) => (
				<li
					aria-current={index === at ? "step" : undefined}
					className="import-step"
					data-state={index < at ? "done" : index === at ? "current" : "upcoming"}
					key={step}
				>
					<span aria-hidden="true" className="import-step-dot">
						{index < at ? "✓" : index + 1}
					</span>
					<span>{step}</span>
				</li>
			))}
		</ol>
	);
}

function Heading({children}: {children: ReactNode})
{
	return <h2 className="text-m leading-s font-medium text-primary">{children}</h2>;
}

/** What the run found: a few headline numbers, and the rest behind a disclosure. */
function FoundSummary({run, imported = false}: {run: WorkflowyImportRun; imported?: boolean})
{
	const details = foundDetails(run);
	return (
		<section className="flex flex-col gap-s" data-workflowy-import-found>
			<h3 className="text-s leading-xs text-tertiary">{imported ? "Brought over" : "Found on workflowy.com"}</h3>
			<ImportStats stats={imported ? importedHeadlines(run) : foundHeadlines(run)} />
			{details.length > 0 && (
				<details className="import-details text-s leading-xs text-primary">
					<summary>Everything else found</summary>
					<dl>
						{details.map((stat) => (
							<div key={stat.label}>
								<dt>{stat.label}</dt>
								<dd>{stat.value}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
		</section>
	);
}

/** What a run that ended left out or could not copy, each with what to do about it. */
function Failures({run}: {run: WorkflowyImportRun})
{
	const {failures, files} = run;
	if (failures.invalidNodes === 0 && failures.metadataSkipped === 0 && files.failures.length === 0)
	{
		return null;
	}
	return (
		<section className="flex flex-col gap-s" data-workflowy-import-failures>
			<h3 className="text-s leading-xs text-danger">Needs attention</h3>
			<ul className="text-s leading-xs text-danger list-disc pl-l">
				{failures.invalidNodes > 0 && (
					<li>{plural(failures.invalidNodes, "item")} could not be read and were left out</li>
				)}
				{failures.metadataSkipped > 0 && (
					<li>
						{plural(failures.metadataSkipped, "metadata entry", "metadata entries")} belonged to items that
						were left out
					</li>
				)}
				{files.failures.map((failure) => (
					<li key={failure.nodeId}>
						{failure.fileName}: {failure.error}
					</li>
				))}
			</ul>
			<Hint>
				{files.failures.length > 0
					? "Re-import to try the failed attachments again; the ones already copied are skipped. "
					: ""}
				{failures.invalidNodes > 0 ? "Items that were left out are still on workflowy.com." : ""}
			</Hint>
		</section>
	);
}

/** The live run: its phase in words, the bar, the stages, and what it has found so far. */
function Running({run}: {run: WorkflowyImportRun})
{
	const progress = importProgress(run);
	const problems = failureCount(run);
	return (
		<div className="flex flex-col gap-l" data-workflowy-import="running">
			<div className="flex flex-col gap-s">
				<output aria-live="polite" className="text-base leading-s text-primary">
					{progress.label}
				</output>
				<ImportProgressBar progress={progress} />
				{progress.detail !== null && (
					<div className="text-s leading-xs text-tertiary" data-workflowy-import-count>
						{progress.detail}
					</div>
				)}
			</div>
			<ol aria-label="Import stages" className="import-stages text-s leading-xs">
				{IMPORT_STAGES.map((stage, index) => (
					<li
						data-state={index < progress.stage ? "done" : index === progress.stage ? "current" : "upcoming"}
						key={stage}
					>
						{stage}
					</li>
				))}
			</ol>
			{hasFound(run) && <FoundSummary run={run} />}
			{/* Only this run's counts: the named failures can still be the last run's until the files phase retries them. */}
			{problems > 0 && (
				<div className="text-s leading-xs text-danger" data-workflowy-import-problems>
					{plural(problems, "problem")} so far. The details show when the import ends.
				</div>
			)}
			<Hint>
				You can close this and keep working. The import carries on, and its progress stays above your outline.
			</Hint>
		</div>
	);
}

interface FlowProps
{
	onClose: () => void;
}

/** The dialog's body: the steps, then the current step. */
function ImportFlow({onClose}: FlowProps)
{
	const {connection, connectionError, run, signIn, cancelSignIn, setMirror, startImport} = useWorkflowyConnection();
	/** The Confirm step's choice, until made: the connection's own setting. */
	const [keepSyncingChoice, setKeepSyncingChoice] = useState<boolean | null>(null);
	const [signingIn, setSigningIn] = useState(false);
	/** Connected in this dialog: the newest run belongs to an earlier connection, so it is not this one's report. */
	const [fresh, setFresh] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const attempt = (action: () => Promise<void>) =>
	{
		setError(null);
		action().catch((caught: unknown) =>
		{
			setError(requestErrorMessage(caught));
		});
	};
	if (connection === undefined)
	{
		return connectionError ? <Alert>{"OutlineDB can't read your workflowy.com connection."}</Alert> : null;
	}

	const running = run?.status === "running";
	const step = fresh && connection.connected && !running ? "Confirm" : importStep(connection, run);
	const start = () =>
	{
		setFresh(false);
		attempt(startImport);
	};
	const keepSyncingRow = (connected: Connected) => (
		<ControlRow
			label="Keep syncing"
			hint={
				connected.mirror
					? "On: your changes go to workflowy.com, and changes made there come here."
					: "Off: this was a one-time import. Nothing here is sent to workflowy.com."
			}
		>
			<Toggle
				className="workflowy-connection-mirror"
				on={connected.mirror}
				onClick={() =>
				{
					attempt(async () => setMirror(!connected.mirror));
				}}
			/>
		</ControlRow>
	);

	let body: ReactNode;
	if (!connection.connected)
	{
		body = (
			<>
				<Heading>Connect your workflowy.com account</Heading>
				<Hint>
					OutlineDB signs in once and keeps only the session, never your password or sign-in code. Nothing is
					imported until you confirm.
				</Hint>
				<SignInForm
					email=""
					onCancel={cancelSignIn}
					onSubmit={async (sent) =>
					{
						const next = await signIn(sent);
						if (next === null)
						{
							setFresh(true);
						}
						return next;
					}}
					submitLabel="Connect"
				/>
			</>
		);
	}
	else if (connection.status === "expired")
	{
		// While a new sign-in is under way, the old session's expiry and its stopped import are not what to look at.
		body = (
			<>
				<Heading>Sign in to workflowy.com again</Heading>
				{!signingIn && (
					<Alert>
						<div>
							Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your
							changes wait until then.
						</div>
						{run?.status === "expired" && (
							<div>The import stopped when the session was refused. Start it again once signed in.</div>
						)}
					</Alert>
				)}
				<SignInForm
					email={connection.email}
					onActiveChange={setSigningIn}
					onCancel={cancelSignIn}
					onSubmit={signIn}
					submitLabel="Sign in again"
				/>
			</>
		);
	}
	else if (step === "Confirm")
	{
		const keepSyncing = keepSyncingChoice ?? connection.mirror;
		body = (
			<>
				<Heading>Ready to import</Heading>
				<div className="text-base leading-s text-primary" data-workflowy-connection="status">
					Connected as {connection.email}
				</div>
				<ul className="text-s leading-s text-primary list-disc pl-l" data-workflowy-import-confirm>
					<li>
						Everything in your workflowy.com account comes over: items, completed items, mirrors,
						attachments, stars, tag colors and saved views.
					</li>
					<li>It replaces your current outline here, including the tutorial.</li>
					<li>The import only reads from workflowy.com. It changes nothing there.</li>
				</ul>
				<label className="flex items-start gap-s text-base leading-s text-primary">
					<input
						checked={keepSyncing}
						name="workflowy-connection-mirror"
						onChange={(event) =>
						{
							setKeepSyncingChoice(event.target.checked);
						}}
						type="checkbox"
					/>
					<span>
						Keep syncing with workflowy.com after the import
						<span className="block text-s leading-xs text-tertiary">
							Changes then flow both ways. Leave it off for a one-time import.
						</span>
					</span>
				</label>
				<div className="flex gap-s">
					<button
						className=" hover:no-underline button primary"
						onClick={() =>
						{
							setFresh(false);
							attempt(async () =>
							{
								if (keepSyncing !== connection.mirror)
								{
									await setMirror(keepSyncing);
								}
								await startImport();
							});
						}}
						type="button"
					>
						<span className="">Import</span>
					</button>
					<SettingsButton onClick={onClose}>Not now</SettingsButton>
				</div>
			</>
		);
	}
	else if (run !== null && running)
	{
		body = (
			<>
				<Heading>Importing your outline</Heading>
				<Running run={run} />
				<div>
					<SettingsButton onClick={onClose}>Close and keep working</SettingsButton>
				</div>
			</>
		);
	}
	else if (run?.status === "ok")
	{
		body = (
			<>
				<Heading>Your outline is here</Heading>
				<div className="flex flex-col gap-l" data-workflowy-import="ok">
					{run.finishedAt !== null && <Hint>Finished {new Date(run.finishedAt).toLocaleString()}</Hint>}
					<FoundSummary imported run={run} />
					<ul className="text-s leading-xs text-primary list-disc pl-l" data-workflowy-import-results>
						{resultLines(run).map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
					<Failures run={run} />
				</div>
				{keepSyncingRow(connection)}
				<div className="flex gap-s">
					<button className=" hover:no-underline button primary" onClick={onClose} type="button">
						<span className="">Go to my outline</span>
					</button>
					<SettingsButton onClick={start}>Re-import</SettingsButton>
				</div>
			</>
		);
	}
	else if (run !== null)
	{
		body = (
			<>
				<Heading>The import stopped</Heading>
				<div className="flex flex-col gap-l" data-workflowy-import={run.status}>
					<Alert>The import failed: {run.message ?? "unknown error"}</Alert>
					<Hint>
						Nothing changed on workflowy.com. Try again to start the import over; if it keeps failing, the
						message above says why.
					</Hint>
					{hasFound(run) && <FoundSummary run={run} />}
					<Failures run={run} />
				</div>
				<div className="flex gap-s">
					<button className=" hover:no-underline button primary" onClick={start} type="button">
						<span className="">Try again</span>
					</button>
					<SettingsButton onClick={onClose}>Close</SettingsButton>
				</div>
			</>
		);
	}
	return (
		<>
			<Steps current={step} />
			<div className="flex flex-col gap-l" data-workflowy-import-step={step}>
				{body}
				{error !== null && <Alert>{error}</Alert>}
			</div>
		</>
	);
}

/** Mounted once: the import dialog, while the store says it is open. */
export function WorkflowyImportDialogHost()
{
	const open = useOutlineStore((state) => state.importDialogOpen);
	const close = useOutlineStore((state) => state.closeImportDialog);
	if (!open)
	{
		return null;
	}
	return (
		<DialogShell onClose={close}>
			{/* DialogTitle's classes, but wrapping: the title does not fit one line at phone width. */}
			<h1 className="title text-l leading-xs font-bold mr-3xl">Import from workflowy.com</h1>
			<ImportFlow onClose={close} />
			<DialogCloseButton onClose={close} />
		</DialogShell>
	);
}
