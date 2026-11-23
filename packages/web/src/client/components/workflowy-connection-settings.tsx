import {useEffect, useState} from "react";
import type {ReactNode, SubmitEvent} from "react";
import {WorkflowyRequestError, useWorkflowyConnection} from "../hooks/use-workflowy-connection.js";
import type
{
	WorkflowyImportFound,
	WorkflowyImportRun,
	WorkflowyLoginField,
	WorkflowyLoginStep,
} from "../../node-types.js";
import {ActionBlock, ControlRow, SectionBody, SettingsButton} from "./settings-rows.js";
import {SettingsSection} from "./settings-section.js";
import {Toggle} from "./toggle.js";

/** The Settings section title, also the `?settings=` value the signup wizard opens. */
export const WORKFLOWY_SECTION = "Workflowy";

function requestErrorMessage(error: unknown): string
{
	if (error instanceof WorkflowyRequestError)
	{
		if (error.code === "workflowy-login-failed")
		{
			return "workflowy.com didn't accept that sign-in.";
		}
		if (error.code === "workflowy-login-unverified")
		{
			return "workflowy.com finished the sign-in but didn't accept the session. Try again.";
		}
		if (error.code === "workflowy-captcha")
		{
			return "workflowy.com wants to check you're human. Try again later.";
		}
		if (error.code === "workflowy-login-expired")
		{
			return "That sign-in took too long. Start again.";
		}
		if (error.code === "workflowy-login-code-expired")
		{
			return "That code expired. Start again to get a new one.";
		}
		if (error.code === "credentials-key-not-configured")
		{
			return "Connecting to workflowy.com isn't available yet.";
		}
		if (error.code === "workflowy-session-expired")
		{
			return "Your workflowy.com session expired. Sign in again first.";
		}
	}
	return "Something went wrong. Try again.";
}

function plural(count: number, one: string, many = `${one}s`): string
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

/** What the run found on workflowy.com: the items always, every other kind only when it found some. */
function foundSummary(found: WorkflowyImportFound, files: number): string
{
	const kinds: [number, string, string?][] = [
		[found.completed, "completed item"],
		[found.mirrors, "mirror"],
		[found.backlinks, "backlink"],
		[files, "attachment"],
		[found.stars, "star"],
		[found.tagColors, "tag color"],
		[found.savedViews, "saved view"],
		[found.settings, "setting"],
		[found.expandedKeys, "expanded item"],
	];
	return [
		plural(found.nodes, "item"),
		...kinds.filter(([count]) => count > 0).map(([count, one, many]) => plural(count, one, many)),
	].join(", ");
}

/** The run's live step, while it runs. */
function progressLabel(run: WorkflowyImportRun): string
{
	if (run.phase === "importing")
	{
		return `Importing items: ${run.applied.toLocaleString()} of ${run.found.nodes.toLocaleString()}`;
	}
	if (run.phase === "files")
	{
		const done = run.files.copied + run.files.alreadyCopied + run.files.failed;
		return `Copying attachments: ${done.toLocaleString()} of ${run.files.found.toLocaleString()}`;
	}
	return "Fetching your outline from workflowy.com";
}

function formatTime(at: number): string
{
	return new Date(at).toLocaleString();
}

function Hint({children}: {children: ReactNode})
{
	return <div className="text-s leading-xs text-tertiary">{children}</div>;
}

function Alert({children}: {children: ReactNode})
{
	return (
		<div className="text-s leading-xs text-danger" role="alert">
			{children}
		</div>
	);
}

/** A refused request's message, and under it what workflowy.com itself answered, when the Worker passed that on. */
function RequestErrorAlert({error}: {error: unknown})
{
	const detail = error instanceof WorkflowyRequestError ? error.detail : undefined;
	return (
		<Alert>
			<div>{requestErrorMessage(error)}</div>
			{detail !== undefined && (
				<div className="settings-reply-detail text-tertiary">workflowy.com said: {detail}</div>
			)}
		</Alert>
	);
}

type SignInStep =
	|
	  {
			email: string;
	  }
	|
	  {
			attemptId: string;
			values: Record<string, string>;
	  };

interface SignInFormProps
{
	email: string;
	submitLabel: string;
	/** Sends one step; resolves with the next one, or null once connected. */
	onSubmit: (step: SignInStep) => Promise<WorkflowyLoginStep | null>;
	/** Start over: ends the attempt in progress on the server. */
	onCancel: () => Promise<void>;
	/** Told whether an attempt is past its email step, so the section can set the old connection's state aside. */
	onActiveChange?: (active: boolean) => void;
}

/** An emailed or authenticator code, which the browser may fill from a message. */
function isCode(field: WorkflowyLoginField): boolean
{
	return /code|otp|token/iu.test(field.name);
}

/** One input the form asked for: a password masked, a code as a one-time code, anything else as text. */
function LoginFieldInput({
	field,
	value,
	onChange,
}: {
	field: WorkflowyLoginField;
	value: string;
	onChange: (value: string) => void;
})
{
	const password = field.type === "password";
	const code = !password && isCode(field);
	return (
		<label className="flex flex-col gap-xs">
			<span className="text-base leading-s text-primary">{field.label}</span>
			<input
				autoComplete={password ? "current-password" : code ? "one-time-code" : "off"}
				className="settings-input"
				inputMode={code ? "numeric" : undefined}
				name={`workflowy-login-${field.name}`}
				onChange={(event) =>
				{
					onChange(event.target.value);
				}}
				required
				type={password ? "password" : "text"}
				value={value}
			/>
		</label>
	);
}

/**
 * Signs in to workflowy.com a step at a time: the email first, then whatever its login form asks for next (a password,
 * a code), with the form's errors and the requests so far. Start over, or a changed email, ends the attempt and goes
 * back to the email. Only the session the login yields is kept, never a password or a code; an answer the form echoed
 * back stays in this browser's memory just long enough to send it again with the next step.
 */
function SignInForm({email: initialEmail, submitLabel, onSubmit, onCancel, onActiveChange}: SignInFormProps)
{
	const [email, setEmail] = useState(initialEmail);
	const [step, setStep] = useState<WorkflowyLoginStep | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<
	{
		caught: unknown;
	} | null>(null);
	const active = step !== null;
	useEffect(() =>
	{
		onActiveChange?.(active);
	}, [active, onActiveChange]);
	const startOver = () =>
	{
		const live = step !== null;
		setStep(null);
		setValues({});
		setError(null);
		if (live)
		{
			onCancel().catch((caught: unknown) =>
			{
				setError(
					{
						caught,
					},
				);
			});
		}
	};
	const submit = (event: SubmitEvent) =>
	{
		event.preventDefault();
		if (busy)
		{
			return;
		}
		setBusy(true);
		setError(null);
		const sent: SignInStep =
			step === null
				?
					{
						email: email.trim(),
					}
				:
					{
						attemptId: step.attemptId,
						values: Object.fromEntries(
							[...step.resend, ...step.fields.map((field) => field.name)].map((name) => [
								name,
								values[name] ?? "",
							]),
						),
					};
		const send = async () =>
		{
			let kept: Record<string, string> = {};
			try
			{
				const next = await onSubmit(sent);
				setStep(next);
				if (next !== null && "values" in sent)
				{
					kept = Object.fromEntries(next.resend.map((name) => [name, sent.values[name] ?? ""]));
				}
			}
			catch (caught)
			{
				// Every refusal but a missing answer ended the attempt upstream, so the next try starts at the email.
				if (!(caught instanceof WorkflowyRequestError && caught.code === "workflowy-login-incomplete"))
				{
					setStep(null);
				}
				setError(
					{
						caught,
					},
				);
			}
			setBusy(false);
			setValues(kept);
		};
		void send();
	};
	return (
		<form className="flex flex-col gap-m" onSubmit={submit}>
			<label className="flex flex-col gap-xs">
				<span className="text-base leading-s text-primary">workflowy.com email</span>
				<input
					autoComplete="username"
					className="settings-input"
					name="workflowy-email"
					onChange={(event) =>
					{
						if (step !== null)
						{
							startOver();
						}
						setEmail(event.target.value);
					}}
					required
					type="email"
					value={email}
				/>
			</label>
			{step?.fields.map((field) => (
				<LoginFieldInput
					field={field}
					key={field.name}
					onChange={(value) =>
					{
						setValues((current) => (
						{
							...current,
							[field.name]: value,
						}));
					}}
					value={values[field.name] ?? ""}
				/>
			))}
			{step !== null && step.errors.length > 0 && (
				<Alert>
					<ul className="list-disc pl-l">
						{step.errors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				</Alert>
			)}
			{step !== null && (
				<div className="settings-reply-detail text-s leading-xs text-tertiary" data-workflowy-login-trace>
					Sign-in steps: {step.detail}
				</div>
			)}
			{error !== null && <RequestErrorAlert error={error.caught} />}
			<div className="flex gap-s">
				<button className=" hover:no-underline button" disabled={busy} type="submit">
					<span className="">{submitLabel}</span>
				</button>
				{!busy && (step !== null || error !== null) && (
					<SettingsButton onClick={startOver}>Start over</SettingsButton>
				)}
			</div>
		</form>
	);
}

/** What the newest run did: its progress while it runs, then its per-kind results and failures. */
function RunReport({run}: {run: WorkflowyImportRun})
{
	// A refused session stops a run before it reads the outline, so it found nothing worth saying.
	const found =
		run.phase === "fetching" || run.status === "expired" ? null : foundSummary(run.found, run.files.found);
	const {nodes, failures, files} = run;
	return (
		<div className="flex flex-col gap-s" data-workflowy-import={run.status}>
			{run.status === "running" && (
				<output className="text-base leading-s text-primary">{progressLabel(run)}</output>
			)}
			{found !== null && <Hint>Found {found}.</Hint>}
			{run.status === "error" && <Alert>The import failed: {run.message ?? "unknown error"}</Alert>}
			{run.status === "expired" && (
				<Alert>workflowy.com refused the session, so the import stopped. Sign in again, then import.</Alert>
			)}
			{run.status === "ok" && (
				<ul className="text-s leading-xs text-primary list-disc pl-l" data-workflowy-import-results>
					<li>
						Items: {nodes.added.toLocaleString()} added, {nodes.updated.toLocaleString()} updated,{" "}
						{nodes.unchanged.toLocaleString()} unchanged, {nodes.phasedOut.toLocaleString()} removed
					</li>
					{files.found > 0 && (
						<li>
							Attachments: {files.copied.toLocaleString()} copied ({formatBytes(files.bytes)}),{" "}
							{files.alreadyCopied.toLocaleString()} already copied, {files.failed.toLocaleString()}{" "}
							failed
						</li>
					)}
				</ul>
			)}
			{(failures.invalidNodes > 0 || failures.metadataSkipped > 0 || files.failures.length > 0) && (
				<ul className="text-s leading-xs text-danger list-disc pl-l" data-workflowy-import-failures>
					{failures.invalidNodes > 0 && (
						<li>{plural(failures.invalidNodes, "item")} could not be read and were left out</li>
					)}
					{failures.metadataSkipped > 0 && (
						<li>
							{plural(failures.metadataSkipped, "metadata entry", "metadata entries")} belonged to items
							that were left out
						</li>
					)}
					{files.failures.map((failure) => (
						<li key={failure.nodeId}>
							{failure.fileName}: {failure.error}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Settings > Workflowy: connect a workflowy.com account, import it (replacing the outline, the tutorial included),
 * and keep syncing with it, re-import, or disconnect. A session workflowy.com refused asks to sign in again.
 */
export function WorkflowySection()
{
	const {connection, connectionError, run, signIn, cancelSignIn, setMirror, startImport, disconnect} =
		useWorkflowyConnection();
	const [keepSyncing, setKeepSyncing] = useState(false);
	const [signingIn, setSigningIn] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const attempt = (action: () => Promise<void>) =>
	{
		setError(null);
		action().catch((caught: unknown) =>
		{
			setError(requestErrorMessage(caught));
		});
	};

	let body: ReactNode;
	if (connection === undefined)
	{
		body = connectionError ? <Alert>{"OutlineDB can't read your workflowy.com connection."}</Alert> : null;
	}
	else if (!connection.connected)
	{
		body = (
			<>
				<Hint>
					Bring your workflowy.com outline into OutlineDB. OutlineDB signs in once and keeps only the session,
					never your password or sign-in code.
				</Hint>
				<SignInForm email="" onCancel={cancelSignIn} onSubmit={signIn} submitLabel="Connect" />
			</>
		);
	}
	else if (connection.status === "expired")
	{
		// While a new sign-in is under way, the old session's expiry and its failed import are not what to look at.
		body = (
			<>
				{!signingIn && (
					<Alert>
						Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes
						wait until then.
					</Alert>
				)}
				<SignInForm
					email={connection.email}
					onActiveChange={setSigningIn}
					onCancel={cancelSignIn}
					onSubmit={signIn}
					submitLabel="Sign in again"
				/>
				{run !== null && !signingIn && <RunReport run={run} />}
				<DisconnectBlock
					onDisconnect={() =>
					{
						attempt(disconnect);
					}}
				/>
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
					<Hint>
						{connection.lastSyncAt === null
							? "Not synced yet"
							: `Last sync: ${formatTime(connection.lastSyncAt)}`}
					</Hint>
				</div>
				{run === null ? (
					<ActionBlock
						label="Import your outline"
						hint="Importing replaces your current outline, including the tutorial, with everything in your workflowy.com account."
					>
						<div className="flex flex-col gap-m">
							<label className="flex items-center gap-s text-base leading-s text-primary">
								<input
									checked={keepSyncing}
									name="workflowy-connection-mirror"
									onChange={(event) =>
									{
										setKeepSyncing(event.target.checked);
									}}
									type="checkbox"
								/>
								Keep syncing with workflowy.com after the import
							</label>
							<div>
								<SettingsButton
									onClick={() =>
									{
										attempt(async () =>
										{
											if (keepSyncing !== connection.mirror)
											{
												await setMirror(keepSyncing);
											}
											await startImport();
										});
									}}
								>
									Import
								</SettingsButton>
							</div>
						</div>
					</ActionBlock>
				) : (
					<>
						<RunReport run={run} />
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
						{!running && (
							<ActionBlock
								label="Re-import"
								hint="Import your workflowy.com account again, replacing the outline here."
							>
								<SettingsButton
									onClick={() =>
									{
										attempt(startImport);
									}}
								>
									Re-import
								</SettingsButton>
							</ActionBlock>
						)}
					</>
				)}
				<DisconnectBlock
					onDisconnect={() =>
					{
						attempt(disconnect);
					}}
				/>
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
