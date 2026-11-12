import {answerConfirm, dismissAlert, useAlertStore, useConfirmStore} from "../alert.js";
import {Button} from "./button.js";
import {DialogCloseButton, DialogShell, DialogTitle} from "./dialog-shell.js";

/** Upstream's alert: a titled dialog with a message, closed by its X or Escape. */
export function AlertDialogView({title, message, onClose}: {title: string; message: string; onClose: () => void})
{
	return (
		<DialogShell onClose={onClose}>
			<DialogTitle>{title}</DialogTitle>
			<div className="text-base leading-base ">{message}</div>
			<DialogCloseButton onClose={onClose} />
		</DialogShell>
	);
}

/** Upstream's confirm: the alert's layout plus one primary button that confirms. */
function ConfirmDialogView({
	title,
	message,
	confirmLabel,
	onAnswer,
}: {
	title: string;
	message: string;
	confirmLabel: string;
	onAnswer: (confirmed: boolean) => void;
})
{
	return (
		<DialogShell
			onClose={() =>
			{
				onAnswer(false);
			}}
		>
			<DialogTitle>{title}</DialogTitle>
			<div className="text-base leading-base ">{message}</div>
			<div className="flex justify-end">
				<Button
					variant="primary"
					onClick={() =>
					{
						onAnswer(true);
					}}
				>
					{confirmLabel}
				</Button>
			</div>
			<DialogCloseButton
				onClose={() =>
				{
					onAnswer(false);
				}}
			/>
		</DialogShell>
	);
}

/** Shows whatever `showAlert` or `confirmAction` last asked for. */
export function AlertDialog()
{
	const alert = useAlertStore((state) => state.alert);
	const confirm = useConfirmStore((state) => state.confirm);
	if (confirm !== null)
	{
		return (
			<ConfirmDialogView
				title={confirm.title}
				message={confirm.message}
				confirmLabel={confirm.confirmLabel}
				onAnswer={answerConfirm}
			/>
		);
	}
	return alert === null ? null : (
		<AlertDialogView title={alert.title} message={alert.message} onClose={dismissAlert} />
	);
}
