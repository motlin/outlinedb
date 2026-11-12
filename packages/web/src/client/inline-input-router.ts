export interface InputRouteState
{
	/** A Suggest chip (slash today, `@` later) was armed when the input arrived. */
	chipArmedBefore: boolean;
	/** The chip handler left a chip armed (or armed a new one). */
	chipArmedAfter: boolean;
	/** The `!!` trigger opened the picker on this input. */
	datePopupOpened: boolean;
}

export interface InputRoute
{
	dateTrigger: boolean;
	dateAutocomplete: boolean;
	tagAutocomplete: boolean;
	detachTags: boolean;
	save: boolean;
}

/**
 * Upstream's `editor.input.*` pipe order: an armed chip never calls `next`, so every later hook is skipped for
 * that input, including the input that disarms the chip. The date trigger runs before the date autocomplete.
 */
export function routeTypedInput({chipArmedBefore, chipArmedAfter, datePopupOpened}: InputRouteState): InputRoute
{
	if (chipArmedBefore || chipArmedAfter)
	{
		return {
			dateTrigger: false,
			dateAutocomplete: false,
			tagAutocomplete: false,
			detachTags: true,
			save: !chipArmedAfter,
		};
	}
	return {
		dateTrigger: true,
		dateAutocomplete: !datePopupOpened,
		tagAutocomplete: true,
		detachTags: false,
		save: true,
	};
}
