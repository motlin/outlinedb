/**
 * Signing in to workflowy.com, a step at a time, and the wording of every refusal: shared by the import dialog's Connect
 * step and its sign-in-again prompt.
 */

import {useEffect, useState} from "react";
import type {ReactNode, SubmitEvent} from "react";
import {WorkflowyRequestError, requestErrorMessage} from "../hooks/use-workflowy-connection.js";
import type {WorkflowyLoginField, WorkflowyLoginStep} from "../../node-types.js";
import {SettingsButton} from "./settings-rows.js";

export function Hint({children}: {children: ReactNode})
{
	return <div className="text-s leading-xs text-tertiary">{children}</div>;
}

export function Alert({children}: {children: ReactNode})
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
export function SignInForm({email: initialEmail, submitLabel, onSubmit, onCancel, onActiveChange}: SignInFormProps)
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
				<button className=" hover:no-underline button primary" disabled={busy} type="submit">
					<span className="">{submitLabel}</span>
				</button>
				{!busy && (step !== null || error !== null) && (
					<SettingsButton onClick={startOver}>Start over</SettingsButton>
				)}
			</div>
		</form>
	);
}
