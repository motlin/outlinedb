import {useOutlineStore} from "../stores/outline.js";

/**
 * Displays error notifications as toast-like messages in the top-right corner.
 * Supports error, warning, and info types with optional retry actions.
 */
export function ErrorNotifications()
{
	const errorNotifications = useOutlineStore((state) => state.errorNotifications);
	const removeErrorNotification = useOutlineStore((state) => state.removeErrorNotification);

	if (errorNotifications.length === 0)
	{
		return null;
	}

	return (
		<div className="error-notifications">
			{errorNotifications.map((notification) => (
				<div className={`error-notification error-notification-${notification.type}`} key={notification.id}>
					<div className="error-notification-content">
						<span className="error-notification-icon">
							{notification.type === "error" && "!"}
							{notification.type === "warning" && "!"}
							{notification.type === "info" && "i"}
						</span>
						<span className="error-notification-message">{notification.message}</span>
					</div>
					<div className="error-notification-actions">
						{notification.retryAction && (
							<button
								className="error-notification-retry"
								onClick={() =>
								{
									notification.retryAction?.();
									removeErrorNotification(notification.id);
								}}
								type="button"
							>
								Retry
							</button>
						)}
						<button
							className="error-notification-dismiss"
							onClick={() =>
							{
								removeErrorNotification(notification.id);
							}}
							type="button"
						>
							Dismiss
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
