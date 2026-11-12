import {isModalOpen, useOutlineStore} from "../stores/outline.js";
import type {AppMessageAction, AppMessageType} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";

const NO_ACTIONS: readonly AppMessageAction[] = [];

const TYPE_STYLES =
{
	success:
	{
		icon: "fas:circle-check",
		color: "text-success",
	},
	warning:
	{
		icon: "fas:triangle-exclamation",
		color: "text-warning",
	},
	failure:
	{
		icon: "fas:circle-exclamation",
		color: "text-danger",
	},
} as const;

const MESSAGE_LEVEL = 500;
const MODAL_LEVEL = 600;

/** Upstream `level.of("message")`, plus `level.of("modal")` while a dialog is open so the toast paints over its backdrop. */
export function appMessageZIndex(): number
{
	return isModalOpen() ? MODAL_LEVEL + MESSAGE_LEVEL : MESSAGE_LEVEL;
}

interface AppMessageProps
{
	text: string;
	type?: AppMessageType;
	zIndex?: number;
	actions?: readonly AppMessageAction[];
	onClose?: () => void;
}

/** Upstream's WF.AppMessages success toast, pinned above the bottom edge of the viewport. */
export function AppMessage({
	text,
	type = "success",
	zIndex = MESSAGE_LEVEL,
	actions = NO_ACTIONS,
	onClose,
}: AppMessageProps)
{
	return (
		<div
			className="flex justify-center fixed left-0 right-0 leading-xs"
			style={
			{
				zIndex,
				bottom: "calc(72px + var(--safe-area-inset-bottom))",
			}}
		>
			<div className="flex flex-row max-w-[90vw] gap-ml px-m shadow-sm bg-primary border border-solid border-primary rounded-s">
				<div className="h-full flex items-center">
					<FaIcon icon={TYPE_STYLES[type].icon} size="lg" className={TYPE_STYLES[type].color} />
				</div>
				<div className="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">
					{text}
				</div>
				{actions.map((action) => (
					// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup; the shortcut is the keyboard path
					<div
						key={action.label}
						className="flex items-center text-primary content-end font-medium desktop:hover:underline cursor-pointer"
						style={
						{
							height: "100%",
						}}
						onClick={(event) =>
						{
							event.preventDefault();
							onClose?.();
							action.run();
						}}
					>
						<div className="flex items-baseline">
							<span className="">{action.label}</span>
							{action.shortcut && (
								<span className="mobile:hidden text-s text-tertiary font-normal ml-xs">
									({action.shortcut})
								</span>
							)}
						</div>
					</div>
				))}
				<div className="h-full flex items-center">
					{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup */}
					<span onClick={onClose} className="p-s cursor-pointer text-tertiary">
						<FaIcon icon="fal:xmark" />
					</span>
				</div>
			</div>
		</div>
	);
}

/** Renders the store's current app message, if any. Mount once at the app root. */
export function AppMessages()
{
	const appMessage = useOutlineStore((state) => state.appMessage);
	const hideAppMessage = useOutlineStore((state) => state.hideAppMessage);
	// Subscribes so the z-index follows dialogs opening and closing.
	const zIndex = useOutlineStore(() => appMessageZIndex());
	if (!appMessage)
	{
		return null;
	}
	return (
		<AppMessage
			text={appMessage.text}
			type={appMessage.type}
			zIndex={zIndex}
			actions={appMessage.actions}
			onClose={hideAppMessage}
		/>
	);
}
