/** Upstream keeps a just-completed row in place this long before hiding it. */
const COMPLETION_HIDE_DELAY_MS = 1000;
/** Fallback for the slideUp's `transitionend` (120ms transition plus slack). */
const SLIDE_UP_FALLBACK_MS = 220;
/** Upstream animates only the first rows of a multi-item completion. */
const SLIDE_UP_MAX_ROWS = 10;

export interface CompletionAnimationActions
{
	beginCompletionAnimation: (ids: string[]) => void;
	startCompletionSlideUp: (ids: string[]) => void;
	endCompletionAnimation: (ids: string[]) => void;
}

/**
 * Upstream's deferred hide for rows completed while completed rows are hidden: the
 * rows stay for 1000ms, then the first 10 play slideUp and hide when it ends (the row's
 * `transitionend` or a 220ms fallback); the rest hide at once. A row that is no longer
 * hidden after the wait (uncompleted, or completed rows shown) skips the slide.
 */
export function scheduleCompletionHide(
	ids: string[],
	actions: CompletionAnimationActions,
	isHidden: (id: string) => boolean,
): void
{
	actions.beginCompletionAnimation(ids);
	setTimeout(() =>
	{
		const hiding = ids.filter((id) => isHidden(id));
		const sliding = hiding.slice(0, SLIDE_UP_MAX_ROWS);
		actions.endCompletionAnimation(ids.filter((id) => !sliding.includes(id)));
		if (sliding.length === 0)
		{
			return;
		}
		actions.startCompletionSlideUp(sliding);
		setTimeout(() =>
		{
			actions.endCompletionAnimation(sliding);
		}, SLIDE_UP_FALLBACK_MS);
	}, COMPLETION_HIDE_DELAY_MS);
}

/** Upstream's delay before a completed zoom root zooms out: the hide wait and slide (hidden mode) plus 500ms. */
export function zoomOutDelayMs(showCompleted: boolean): number
{
	return showCompleted ? 500 : COMPLETION_HIDE_DELAY_MS + SLIDE_UP_FALLBACK_MS + 500;
}
