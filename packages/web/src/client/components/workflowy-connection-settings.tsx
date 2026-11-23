import {useState} from "react";
import type {ReactNode} from "react";
import {requestErrorMessage, useWorkflowyConnection} from "../hooks/use-workflowy-connection.js";
import type {WorkflowyImportRun} from "../../node-types.js";
import {useOutlineStore} from "../stores/outline.js";
import {failureCount, importProgress, plural} from "../workflowy-import-model.js";
import {ActionBlock, ControlRow, SectionBody, SettingsButton} from "./settings-rows.js";
import {SettingsSection} from "./settings-section.js";
import {Toggle} from "./toggle.js";
import {Alert, Hint} from "./workflowy-login-form.js";

/** The Settings section title. */
export const WORKFLOWY_SECTION = "Workflowy";

function formatTime(at: number): string
{
	return new Date(at).toLocaleString();
}

/**
 * One line under "Connected as": the run under way, never the last sync or the last run's outcome while a new run is
 * running; otherwise how the newest import ended and when the outline last synced.
 */
function statusLine(run: WorkflowyImportRun | null, lastSyncAt: number | null): string
{
	if (run?.status === "running")
	{
		const progress = importProgress(run);
		return `Import in progress: ${progress.label}${progress.detail === null ? "" : `, ${progress.detail}`}`;
	}
	const sync = lastSyncAt === null ? "Not synced yet" : `Last sync: ${formatTime(lastSyncAt)}`;
	if (run === null || run.status === "expired")
	{
		return sync;
	}
	if (run.status === "error")
	{
		return `The last import failed. ${sync}`;
	}
	const problems = failureCount(run);
	return `Imported ${plural(run.found.nodes, "item")}${problems > 0 ? `, ${plural(problems, "problem")}` : ""}. ${sync}`;
}

/**
 * Settings > Workflowy: the connection at a glance (who, the import under way or how the last one went), keep
 * syncing, re-import and disconnect. Connecting, confirming and watching an import happen in the import dialog, which
 * every button here that starts or shows one opens in place of Settings.
 */
export function WorkflowySection()
{
	const {connection, connectionError, run, setMirror, startImport, disconnect} = useWorkflowyConnection();
	const openImportDialog = useOutlineStore((state) => state.openImportDialog);
	const [error, setError] = useState<string | null>(null);
	const attempt = (action: () => Promise<void>) =>
	{
		setError(null);
		action().catch((caught: unknown) =>
		{
			setError(requestErrorMessage(caught));
		});
	};
	const disconnectBlock = (
		<DisconnectBlock
			onDisconnect={() =>
			{
				attempt(disconnect);
			}}
		/>
	);

	let body: ReactNode;
	if (connection === undefined)
	{
		body = connectionError ? <Alert>{"OutlineDB can't read your workflowy.com connection."}</Alert> : null;
	}
	else if (!connection.connected)
	{
		body = (
			<ActionBlock
				label="Import your outline"
				hint="Bring your workflowy.com outline into OutlineDB, and keep the two in sync if you like."
			>
				<SettingsButton onClick={openImportDialog}>Import from workflowy.com</SettingsButton>
			</ActionBlock>
		);
	}
	else if (connection.status === "expired")
	{
		body = (
			<>
				<Alert>
					Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes wait
					until then.
				</Alert>
				<div>
					<SettingsButton onClick={openImportDialog}>Sign in again</SettingsButton>
				</div>
				{disconnectBlock}
			</>
		);
	}
	else
	{
		const running = run?.status === "running";
		body = (
			<>
				<div className="flex flex-col gap-xs" data-workflowy-connection="status">
					<div className="text-base leading-s text-primary">Connected as {connection.email}</div>
					<Hint>{statusLine(run, connection.lastSyncAt)}</Hint>
				</div>
				<ControlRow
					label="Keep syncing"
					hint="Send your changes to workflowy.com and bring in changes made there. Off, the import was one-time."
				>
					<Toggle
						className="workflowy-connection-mirror"
						on={connection.mirror}
						onClick={() =>
						{
							attempt(async () => setMirror(!connection.mirror));
						}}
					/>
				</ControlRow>
				<ActionBlock
					label="Import"
					hint={
						running
							? "An import is under way. You can keep working while it runs."
							: "Importing replaces the outline here with everything in your workflowy.com account."
					}
				>
					<div className="flex flex-wrap gap-s">
						{run === null && <SettingsButton onClick={openImportDialog}>Import</SettingsButton>}
						{run !== null && !running && (
							<SettingsButton
								onClick={() =>
								{
									openImportDialog();
									attempt(startImport);
								}}
							>
								Re-import
							</SettingsButton>
						)}
						{run !== null && (
							<SettingsButton onClick={openImportDialog}>
								{running ? "View progress" : "View last import"}
							</SettingsButton>
						)}
					</div>
				</ActionBlock>
				{disconnectBlock}
			</>
		);
	}
	return (
		<SettingsSection title={WORKFLOWY_SECTION}>
			<SectionBody>
				{body}
				{error !== null && <Alert>{error}</Alert>}
			</SectionBody>
		</SettingsSection>
	);
}

function DisconnectBlock({onDisconnect}: {onDisconnect: () => void})
{
	return (
		<ActionBlock
			label="Disconnect"
			hint="Forget the workflowy.com session and stop syncing. Your outline here stays as it is."
			danger
		>
			<SettingsButton danger onClick={onDisconnect}>
				Disconnect
			</SettingsButton>
		</ActionBlock>
	);
}
