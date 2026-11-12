import type {CSSProperties} from "react";

/** Upstream debounces typing in the header search box by a full second before committing. */
const SEARCH_DEBOUNCE_MS = 1000;

interface SearchBoxControllerOptions
{
	commit: (query: string) => void;
	/** The committed query ("" when none), read at call time. */
	getCommitted: () => string;
}

export interface SearchBoxKeyResult
{
	preventDefault: boolean;
	action: "none" | "focusOutline";
}

export interface SearchBoxController
{
	change: (value: string) => void;
	/** `input` overrides the last changed value, e.g. the store's input after a URL-driven update. */
	key: (key: string, input?: string) => SearchBoxKeyResult;
	dispose: () => void;
}

/** The header search box's timer and key logic: debounced commits, Enter commits now, Tab hands focus back. */
export function createSearchBoxController({commit, getCommitted}: SearchBoxControllerOptions): SearchBoxController
{
	let timer: ReturnType<typeof setTimeout> | null = null;
	let input = "";

	const cancel = () =>
	{
		if (timer !== null)
		{
			clearTimeout(timer);
			timer = null;
		}
	};

	return {
		change: (value) =>
		{
			input = value;
			cancel();
			if (value === getCommitted())
			{
				return;
			}
			if (value === "")
			{
				commit("");
				return;
			}
			timer = setTimeout(() =>
			{
				timer = null;
				commit(value);
			}, SEARCH_DEBOUNCE_MS);
		},
		key: (key, override) =>
		{
			if (override !== undefined)
			{
				input = override;
			}
			if (key === "Enter")
			{
				cancel();
				if (input !== "" || getCommitted() !== "")
				{
					commit(input);
				}
				return {
					preventDefault: true,
					action: "none",
				};
			}
			if (key === "Tab")
			{
				return {
					preventDefault: true,
					action: "focusOutline",
				};
			}
			return {
				preventDefault: false,
				action: "none",
			};
		},
		dispose: cancel,
	};
}

/** The search pill's rounded border on every side in `color`. */
export function borderStyle(color: string): CSSProperties
{
	const side = `var(--wf-border-width-s) solid ${color}`;
	return {
		borderRadius: 20,
		borderTop: side,
		borderRight: side,
		borderLeft: side,
		borderBottom: side,
	};
}
