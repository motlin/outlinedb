import {useEffect, useEffectEvent, useRef} from "react";

interface TurnstileOptions
{
	sitekey: string;
	callback: (token: string) => void;
	"expired-callback"?: () => void;
	"error-callback"?: () => void;
}

interface TurnstileApi
{
	render: (element: HTMLElement, options: TurnstileOptions) => string | undefined;
	remove: (widgetId: string) => void;
}

declare global
{
	// Set by Cloudflare's Turnstile script once it loads.
	var turnstile: TurnstileApi | undefined;
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | undefined;

/** Loads Cloudflare's Turnstile script once, on the first screen that needs it. */
async function loadTurnstile(): Promise<TurnstileApi>
{
	if (globalThis.turnstile)
	{
		return Promise.resolve(globalThis.turnstile);
	}
	loading ??= new Promise<TurnstileApi>((resolve, reject) =>
	{
		const script = document.createElement("script");
		script.src = TURNSTILE_SCRIPT;
		script.async = true;
		script.addEventListener("load", () =>
		{
			if (globalThis.turnstile)
			{
				resolve(globalThis.turnstile);
			}
			else
			{
				reject(new Error("Turnstile loaded without its API"));
			}
		});
		script.addEventListener("error", () =>
		{
			loading = undefined;
			script.remove();
			reject(new Error("Failed to load Turnstile"));
		});
		document.head.append(script);
	});
	return loading;
}

/** Cloudflare's Turnstile widget. `onToken` gets each solved token, and "" when it expires or fails. */
export function Turnstile({siteKey, onToken}: {siteKey: string; onToken: (token: string) => void})
{
	const element = useRef<HTMLDivElement>(null);
	const tokenChanged = useEffectEvent((token: string) =>
	{
		onToken(token);
	});
	useEffect(() =>
	{
		let cancelled = false;
		let widgetId: string | undefined;
		const clear = () =>
		{
			tokenChanged("");
		};
		const render = (api: TurnstileApi) =>
		{
			if (!cancelled && element.current)
			{
				widgetId = api.render(
					element.current,
					{
						sitekey: siteKey,
						callback: tokenChanged,
						"expired-callback": clear,
						"error-callback": clear,
					},
				);
			}
		};
		loadTurnstile()
			.then(render)
			.catch((error: unknown) =>
			{
				console.error(error);
			});
		return () =>
		{
			cancelled = true;
			if (widgetId !== undefined)
			{
				globalThis.turnstile?.remove(widgetId);
			}
		};
	}, [siteKey]);
	return <div className="auth-turnstile" ref={element} />;
}
