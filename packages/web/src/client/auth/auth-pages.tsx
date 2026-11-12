import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {useEffect, useState} from "react";
import type {ReactNode, SubmitEvent} from "react";
import {BrowserRouter, Link, Route, Routes, useNavigate, useSearchParams} from "react-router-dom";
import {Turnstile} from "../components/turnstile.js";
import {authClient, captchaHeaders} from "./auth-client.js";
import {useAuthConfig} from "./auth-config.js";
import {safeNext} from "./login-redirect.js";
import "./auth.css";

/** A Better Auth client error: its JSON body (`code` and `message`, or our Worker's `{error}`) plus the status. */
interface AuthError
{
	status: number;
	code?: string;
	message?: string;
	error?: string;
}

const UNVERIFIED = "EMAIL_NOT_VERIFIED";

/** What to tell the user for a failed auth request. */
function authErrorMessage(error: AuthError): string
{
	if (error.error === "signup-closed")
	{
		return "OutlineDB isn't open for signups yet.";
	}
	if (error.error === "auth-not-configured" || error.error === "captcha-not-configured")
	{
		return "Sign-in isn't available yet. Try again later.";
	}
	if (error.code === "MISSING_RESPONSE" || error.code === "VERIFICATION_FAILED")
	{
		return "The human check didn't pass. Try again.";
	}
	if (error.status === 429)
	{
		return "Too many attempts. Wait a minute and try again.";
	}
	return error.message ?? "Something went wrong. Try again.";
}

/** Keeps the latest Turnstile token; `reset` remounts the widget, since a token works once. */
function useCaptcha(siteKey: string | null)
{
	const [token, setToken] = useState("");
	const [generation, setGeneration] = useState(0);
	const widget = siteKey === null ? null : <Turnstile key={generation} onToken={setToken} siteKey={siteKey} />;
	const reset = () =>
	{
		setToken("");
		setGeneration((value) => value + 1);
	};
	return {
		token,
		widget,
		reset,
	};
}

function AuthCard({title, children}: {title: string; children: ReactNode})
{
	return (
		<main className="auth-page">
			<div className="auth-card">
				<div className="auth-brand">OutlineDB</div>
				<h1 className="auth-title">{title}</h1>
				{children}
			</div>
		</main>
	);
}

function Field({
	label,
	name,
	type,
	value,
	onChange,
	autoComplete,
}: {
	label: string;
	name: string;
	type: string;
	value: string;
	onChange: (value: string) => void;
	autoComplete: string;
})
{
	return (
		<label className="auth-field">
			<span>{label}</span>
			<input
				autoComplete={autoComplete}
				minLength={type === "password" ? 8 : undefined}
				name={name}
				onChange={(event) =>
				{
					onChange(event.target.value);
				}}
				required
				type={type}
				value={value}
			/>
		</label>
	);
}

function Alert({children}: {children: ReactNode})
{
	return (
		<p className="auth-alert" role="alert">
			{children}
		</p>
	);
}

function Notice({children}: {children: ReactNode})
{
	return <output className="auth-notice">{children}</output>;
}

/** Runs a form's submit once at a time, with the default navigation prevented. */
function useSubmit(action: () => Promise<void>)
{
	const [busy, setBusy] = useState(false);
	const onSubmit = (event: SubmitEvent) =>
	{
		event.preventDefault();
		if (busy)
		{
			return;
		}
		setBusy(true);
		void action().finally(() =>
		{
			setBusy(false);
		});
	};
	return {
		busy,
		onSubmit,
	};
}

function ResendLink({email}: {email: string})
{
	const [sent, setSent] = useState(false);
	if (sent)
	{
		return <Notice>We sent a new link to {email}.</Notice>;
	}
	return (
		<button
			className="auth-link-button"
			onClick={() =>
			{
				void authClient
					.sendVerificationEmail(
						{
							email,
							callbackURL: "/",
						},
					)
					.finally(() =>
					{
						setSent(true);
					});
			}}
			type="button"
		>
			Send the link again
		</button>
	);
}

function LoginPage({siteKey}: {siteKey: string | null})
{
	const [params] = useSearchParams();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [unverified, setUnverified] = useState<string | null>(null);
	const captcha = useCaptcha(siteKey);
	const next = safeNext(params.get("next"));
	const {busy, onSubmit} = useSubmit(async () =>
	{
		setError(null);
		setUnverified(null);
		const result = await authClient.signIn.email(
			{
				email,
				password,
			},
			captchaHeaders(captcha.token),
		);
		if (result.error)
		{
			captcha.reset();
			if (result.error.code === UNVERIFIED)
			{
				setUnverified(email);
			}
			else
			{
				setError(authErrorMessage(result.error));
			}
			return;
		}
		globalThis.location.assign(next);
	});
	return (
		<AuthCard title="Log in">
			<form className="auth-form" onSubmit={onSubmit}>
				<Field autoComplete="email" label="Email" name="email" onChange={setEmail} type="email" value={email} />
				<Field
					autoComplete="current-password"
					label="Password"
					name="password"
					onChange={setPassword}
					type="password"
					value={password}
				/>
				{captcha.widget}
				{error !== null && <Alert>{error}</Alert>}
				{unverified !== null && (
					<>
						<Alert>Verify your email first: open the link we sent to {unverified}.</Alert>
						<ResendLink email={unverified} />
					</>
				)}
				<button className="auth-submit" disabled={busy} type="submit">
					Log in
				</button>
			</form>
			<p className="auth-links">
				<Link to={`/signup?${params.toString()}`}>Create an account</Link>
				<Link to="/reset-password">Forgot your password?</Link>
			</p>
		</AuthCard>
	);
}

function SignupPage({siteKey}: {siteKey: string | null})
{
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const captcha = useCaptcha(siteKey);
	const {busy, onSubmit} = useSubmit(async () =>
	{
		setError(null);
		const result = await authClient.signUp.email(
			{
				email,
				password,
				name: email.split("@")[0] ?? email,
				callbackURL: safeNext(params.get("next")),
			},
			captchaHeaders(captcha.token),
		);
		if (result.error)
		{
			captcha.reset();
			setError(authErrorMessage(result.error));
			return;
		}
		void navigate(
			`/verify-email?${new URLSearchParams(
				{
					email,
				},
			).toString()}`,
		);
	});
	return (
		<AuthCard title="Create your OutlineDB account">
			<form className="auth-form" onSubmit={onSubmit}>
				<Field autoComplete="email" label="Email" name="email" onChange={setEmail} type="email" value={email} />
				<Field
					autoComplete="new-password"
					label="Password"
					name="password"
					onChange={setPassword}
					type="password"
					value={password}
				/>
				{captcha.widget}
				{error !== null && <Alert>{error}</Alert>}
				<button className="auth-submit" disabled={busy} type="submit">
					Sign up
				</button>
			</form>
			<p className="auth-links">
				<Link to={`/login?${params.toString()}`}>Already have an account? Log in</Link>
			</p>
		</AuthCard>
	);
}

function VerifyEmailPage()
{
	const [params] = useSearchParams();
	const email = params.get("email");
	return (
		<AuthCard title="Check your email">
			<p className="auth-text">
				{email === null
					? "We sent you a link. Open it to verify your email and sign in to OutlineDB."
					: `We sent a link to ${email}. Open it to verify your email and sign in to OutlineDB.`}
			</p>
			{email !== null && <ResendLink email={email} />}
			<p className="auth-links">
				<Link to="/login">Back to log in</Link>
			</p>
		</AuthCard>
	);
}

function RequestResetForm({siteKey, expired}: {siteKey: string | null; expired: boolean})
{
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<string | null>(null);
	const captcha = useCaptcha(siteKey);
	const {busy, onSubmit} = useSubmit(async () =>
	{
		setError(null);
		const result = await authClient.requestPasswordReset(
			{
				email,
				redirectTo: "/reset-password",
			},
			captchaHeaders(captcha.token),
		);
		if (result.error)
		{
			captcha.reset();
			setError(authErrorMessage(result.error));
			return;
		}
		setSent(email);
	});
	if (sent !== null)
	{
		return <Notice>If an OutlineDB account uses {sent}, we sent it a link to reset the password.</Notice>;
	}
	return (
		<form className="auth-form" onSubmit={onSubmit}>
			{expired && <Alert>That reset link is invalid or expired. Ask for a new one.</Alert>}
			<Field autoComplete="email" label="Email" name="email" onChange={setEmail} type="email" value={email} />
			{captcha.widget}
			{error !== null && <Alert>{error}</Alert>}
			<button className="auth-submit" disabled={busy} type="submit">
				Send a reset link
			</button>
		</form>
	);
}

function NewPasswordForm({token}: {token: string})
{
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const {busy, onSubmit} = useSubmit(async () =>
	{
		setError(null);
		const result = await authClient.resetPassword(
			{
				newPassword: password,
				token,
			},
		);
		if (result.error)
		{
			setError(authErrorMessage(result.error));
			return;
		}
		setDone(true);
	});
	if (done)
	{
		return (
			<Notice>
				Your password is changed. <Link to="/login">Log in</Link>
			</Notice>
		);
	}
	return (
		<form className="auth-form" onSubmit={onSubmit}>
			<Field
				autoComplete="new-password"
				label="New password"
				name="password"
				onChange={setPassword}
				type="password"
				value={password}
			/>
			{error !== null && <Alert>{error}</Alert>}
			<button className="auth-submit" disabled={busy} type="submit">
				Set password
			</button>
		</form>
	);
}

function ResetPasswordPage({siteKey}: {siteKey: string | null})
{
	const [params] = useSearchParams();
	const token = params.get("token");
	return (
		<AuthCard title="Reset your password">
			{token === null ? (
				<RequestResetForm expired={params.has("error")} siteKey={siteKey} />
			) : (
				<NewPasswordForm token={token} />
			)}
			<p className="auth-links">
				<Link to="/login">Back to log in</Link>
			</p>
		</AuthCard>
	);
}

/** The auth screens, once `/api/auth-config` says this host has sign-in; the Node host never shows them. */
function AuthRoutes()
{
	const {data: config, isError} = useAuthConfig();
	const hosted = config?.hosted;
	useEffect(() =>
	{
		if (hosted === false)
		{
			globalThis.location.replace("/");
		}
	}, [hosted]);
	if (isError)
	{
		return (
			<AuthCard title="Log in">
				<Alert>{"OutlineDB can't reach its server. Reload to try again."}</Alert>
			</AuthCard>
		);
	}
	if (config?.hosted !== true)
	{
		return null;
	}
	const siteKey = config.turnstileSiteKey;
	return (
		<Routes>
			<Route element={<LoginPage siteKey={siteKey} />} path="/login" />
			<Route element={<SignupPage siteKey={siteKey} />} path="/signup" />
			<Route element={<VerifyEmailPage />} path="/verify-email" />
			<Route element={<ResetPasswordPage siteKey={siteKey} />} path="/reset-password" />
		</Routes>
	);
}

/** The OutlineDB login, signup, verify-email and reset-password screens, mounted instead of the outline. */
export function AuthApp()
{
	const [client] = useState(
		() =>
			new QueryClient(
				{
					defaultOptions:
					{
						queries:
						{
							retry: false,
						},
					},
				},
			),
	);
	return (
		<QueryClientProvider client={client}>
			<BrowserRouter>
				<AuthRoutes />
			</BrowserRouter>
		</QueryClientProvider>
	);
}
