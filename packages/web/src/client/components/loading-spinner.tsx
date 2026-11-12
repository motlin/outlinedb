export function LoadingSpinner({size = "medium"}: {size?: "small" | "medium" | "large"})
{
	return (
		<div className={`loading-spinner loading-spinner-${size}`}>
			<div className="loading-spinner-circle" />
		</div>
	);
}
