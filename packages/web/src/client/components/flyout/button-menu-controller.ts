// Port of upstream WF.DomKit.ButtonMenu (`w24`) open/close state machine, kept
// framework-free so the component only wires DOM events to these transitions.

const JUST_OPENED_GUARD_MS = 300;
const HOVER_HIDE_DELAY_MS = 100;

export type ButtonMenuClickAction = "none" | "open" | "hide" | "blur";

export interface ButtonMenuControllerOptions
{
	actOnHover?: boolean;
	blockCloseOnInternalClick?: boolean;
	forId?: string;
	setTimeout: (fn: () => void, ms: number) => number;
	clearTimeout: (id: number) => void;
	bodyClassList:
	{
		add(name: string): void;
		remove(name: string): void;
	};
	onShow?: () => void;
	onHide?: () => void;
	focusTrigger?: () => void;
}

export interface ButtonMenuController
{
	focus(): void;
	blur(): void;
	mouseEnter(): void;
	mouseLeave(): void;
	flyoutPointerDown(): void;
	/**
	 * `activeInsideTrigger` is null when document.activeElement is not an HTMLElement.
	 * `fromFlyout`: the click started inside the flyout and only reached the trigger by
	 * bubbling through the React portal (upstream's flyout is not inside the trigger).
	 */
	click(activeInsideTrigger: boolean | null, fromFlyout?: boolean): ButtonMenuClickAction;
	isOpen(): boolean;
}

export function createButtonMenuController(options: ButtonMenuControllerOptions): ButtonMenuController
{
	const {actOnHover = false, blockCloseOnInternalClick = false, forId} = options;
	const bodyClass = forId === undefined ? undefined : `button-menu-for-${forId}`;
	let open = false;
	let justOpened = false;
	let guardTimer: number | undefined;
	let hideTimer: number | undefined;
	let pointerDownInFlyout = false;

	function show(): void
	{
		if (bodyClass !== undefined)
		{
			options.bodyClassList.add(bodyClass);
		}
		open = true;
		justOpened = true;
		if (guardTimer !== undefined)
		{
			options.clearTimeout(guardTimer);
		}
		guardTimer = options.setTimeout(() =>
		{
			justOpened = false;
			guardTimer = undefined;
		}, JUST_OPENED_GUARD_MS);
		options.onShow?.();
	}

	function hide(): void
	{
		if (pointerDownInFlyout && blockCloseOnInternalClick)
		{
			pointerDownInFlyout = false;
			options.focusTrigger?.();
			return;
		}
		if (bodyClass !== undefined)
		{
			options.bodyClassList.remove(bodyClass);
		}
		open = false;
		options.onHide?.();
	}

	function clearHideTimer(): void
	{
		if (hideTimer !== undefined)
		{
			options.clearTimeout(hideTimer);
		}
		hideTimer = undefined;
	}

	return {
		focus: show,
		blur: hide,
		mouseEnter()
		{
			if (!actOnHover)
			{
				return;
			}
			clearHideTimer();
			show();
		},
		mouseLeave()
		{
			if (!actOnHover)
			{
				return;
			}
			clearHideTimer();
			hideTimer = options.setTimeout(() =>
			{
				hideTimer = undefined;
				hide();
			}, HOVER_HIDE_DELAY_MS);
		},
		flyoutPointerDown()
		{
			pointerDownInFlyout = true;
		},
		click(activeInsideTrigger, fromFlyout = false)
		{
			if (fromFlyout)
			{
				return "none";
			}
			if (!open)
			{
				if (actOnHover)
				{
					return "none";
				}
				show();
				return "open";
			}
			if (justOpened || actOnHover)
			{
				return "none";
			}
			if (activeInsideTrigger !== true)
			{
				hide();
				return "hide";
			}
			return "blur";
		},
		isOpen: () => open,
	};
}
