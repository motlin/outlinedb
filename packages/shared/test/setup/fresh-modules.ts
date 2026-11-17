import {vi} from "vite-plus/test";

/**
 * Files in a shared-process project run one after another in the same worker. Before each file, undo what the last
 * one may have left behind: fake timers, stubbed globals and env vars, and every module it evaluated, so module-level
 * state (stores, registries, caches, mocks) starts fresh while the worker keeps its loaded dependencies.
 *
 * DOM files also share one happy-dom window. For them, cancel what the last file left running (timers, animation
 * frames, fetches), give this one the blank page at the default URL a fresh window has, and put back every window
 * global the last one replaced: Vitest exposes window globals as accessors that keep whatever was last assigned, so
 * restoring a spy or a stub only re-installs the accessor and leaves the replacement in place.
 */
vi.useRealTimers();
vi.unstubAllGlobals();
vi.unstubAllEnvs();
vi.resetModules();

interface HappyDom
{
	abort(): Promise<void>;
	setURL(url: string): void;
}

/** Window globals as the first file in this worker found them: functions and primitive values only. */
const PRISTINE = Symbol.for("outlinedb.test.pristine-window-globals");
/** Globals that are the page itself, which the steps below reset instead. */
const PAGE = new Set(["location", "document", "window", "self", "top", "parent", "frames", "happyDOM"]);

function windowGlobals(): Map<string, unknown>
{
	const globals = new Map<string, unknown>();
	for (const key of Object.getOwnPropertyNames(globalThis))
	{
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (PAGE.has(key) || descriptor?.get === undefined || descriptor.set === undefined)
		{
			continue;
		}
		const value: unknown = Reflect.get(globalThis, key);
		if (typeof value === "function" || value === null || typeof value !== "object")
		{
			globals.set(key, value);
		}
	}
	return globals;
}

function isHappyDom(value: unknown): value is HappyDom
{
	return typeof value === "object" && value !== null && "abort" in value && "setURL" in value;
}

const dom: unknown = Reflect.get(globalThis, "happyDOM");
if (isHappyDom(dom))
{
	await dom.abort();
	dom.setURL("http://localhost:3000/");
	document.body.replaceChildren();
	scrollTo(0, 0);
	localStorage.clear();
	sessionStorage.clear();
	const pristine: unknown = Reflect.get(globalThis, PRISTINE);
	if (pristine instanceof Map)
	{
		for (const [key, value] of pristine)
		{
			if (Reflect.get(globalThis, key) !== value)
			{
				try
				{
					Reflect.set(globalThis, key, value);
				}
				catch (error)
				{
					// A read-only value (scroll offsets) cannot have been assigned by a test; scrollTo above reset it.
					if (!(error instanceof TypeError))
					{
						throw error;
					}
				}
			}
		}
	}
	else
	{
		Reflect.set(globalThis, PRISTINE, windowGlobals());
	}
}
