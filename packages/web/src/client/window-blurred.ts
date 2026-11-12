/** Upstream's `body.wf-dom-window-blurred`: present while the window lacks focus, dimming item-selection tints. */
const WINDOW_BLURRED_CLASS = "wf-dom-window-blurred";

interface WindowEvents
{
	addEventListener(type: "blur" | "focus", listener: () => void): void;
	removeEventListener(type: "blur" | "focus", listener: () => void): void;
}

interface ClassListOwner
{
	classList:
	{
		toggle(name: string, force: boolean): boolean;
	};
}

/** Toggles the blurred class on `body` as `win` loses and regains focus; returns the cleanup. */
export function installWindowBlurredClass(win: WindowEvents, body: ClassListOwner): () => void
{
	const onBlur = () =>
	{
		body.classList.toggle(WINDOW_BLURRED_CLASS, true);
	};
	const onFocus = () =>
	{
		body.classList.toggle(WINDOW_BLURRED_CLASS, false);
	};
	win.addEventListener("blur", onBlur);
	win.addEventListener("focus", onFocus);
	return () =>
	{
		win.removeEventListener("blur", onBlur);
		win.removeEventListener("focus", onFocus);
	};
}
