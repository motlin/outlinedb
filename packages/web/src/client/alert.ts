import {create} from "zustand";

/** Upstream `WF.GuiDialogs.showAlert(message, title)`: one message dialog at a time. */
export interface AlertState
{
	alert:
	{
		title: string;
		message: string;
	} | null;
}

export const useAlertStore = create<AlertState>(() => (
{
	alert: null,
}));

/** A confirm dialog (upstream `WF.GuiDialogs.confirm`): a titled message with a confirm button; Escape or the X cancels. */
export interface ConfirmState
{
	confirm:
	{
		title: string;
		message: string;
		confirmLabel: string;
		resolve: (confirmed: boolean) => void;
	} | null;
}

export const useConfirmStore = create<ConfirmState>(() => (
{
	confirm: null,
}));

/** Asks and resolves true only when the user presses the confirm button. */
export async function confirmAction(message: string, title: string, confirmLabel: string): Promise<boolean>
{
	return new Promise((resolve) =>
	{
		useConfirmStore.getState().confirm?.resolve(false);
		useConfirmStore.setState(
			{
				confirm:
				{
					title,
					message,
					confirmLabel,
					resolve,
				},
			},
		);
	});
}

export function answerConfirm(confirmed: boolean): void
{
	const current = useConfirmStore.getState().confirm;
	useConfirmStore.setState(
		{
			confirm: null,
		},
	);
	current?.resolve(confirmed);
}

export function showAlert(message: string, title: string): void
{
	useAlertStore.setState(
		{
			alert:
			{
				title,
				message,
			},
		},
	);
}

export function dismissAlert(): void
{
	useAlertStore.setState(
		{
			alert: null,
		},
	);
}
