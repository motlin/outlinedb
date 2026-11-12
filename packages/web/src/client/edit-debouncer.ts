/** Upstream's `saveLater` delay: a pause this long in typing saves the text. */
export const TEXT_SAVE_DEBOUNCE_MS = 500;

/** One text save: the value as last saved, and the value it becomes. */
export interface TextEdit
{
	before: string;
	after: string;
}

export interface EditDebouncer
{
	/** The editor now holds `value` as saved (editing started, or a command saved it); drops a pending save. */
	reset(value: string): void;
	/** The text changed to `value`; it saves once the editor has been idle for `delay`. */
	change(value: string): void;
	/** Saves `value` now if it differs from the saved value, cancelling any pending save. */
	saveNow(value: string): void;
	/** Saves the pending text now; a no-op when nothing is pending. */
	flush(): void;
	/** A change is waiting for its idle timer. */
	readonly pending: boolean;
	/** The value as last saved (or reset). */
	readonly saved: string;
}

/**
 * Upstream's `saveLater`: every pause of `delay` in typing saves one edit, so each pause is its
 * own undo step, and `flush` (before undo, ⌘S, or leaving the row) saves the rest at once.
 */
export function createEditDebouncer({delay, save}: {delay: number; save: (edit: TextEdit) => void}): EditDebouncer
{
	let saved = "";
	let latest: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function cancel(): void
	{
		if (timer !== undefined)
		{
			globalThis.clearTimeout(timer);
			timer = undefined;
		}
		latest = null;
	}

	function saveNow(value: string): void
	{
		cancel();
		if (value !== saved)
		{
			const edit =
			{
				before: saved,
				after: value,
			};
			saved = value;
			save(edit);
		}
	}

	function flush(): void
	{
		if (latest !== null)
		{
			saveNow(latest);
		}
	}

	return {
		reset(value)
		{
			cancel();
			saved = value;
		},
		change(value)
		{
			if (timer !== undefined)
			{
				globalThis.clearTimeout(timer);
			}
			latest = value;
			timer = globalThis.setTimeout(flush, delay);
		},
		saveNow,
		flush,
		get pending()
		{
			return latest !== null;
		},
		get saved()
		{
			return saved;
		},
	};
}
