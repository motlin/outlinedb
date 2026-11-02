import {Component} from "react";
import type {ReactNode} from "react";

interface ErrorBoundaryProps
{
	children: ReactNode;
	fallback?: ReactNode;
}

interface ErrorBoundaryState
{
	hasError: boolean;
	error: Error | null;
}

/** Upstream's no-unsaved-data fatal screen (`Ys1`): "Try again" reloads the page (`Zs1`). */
export function FatalErrorScreen({message}: {message: string}): ReactNode
{
	return (
		<div className="error-boundary">
			<svg
				className="error-boundary-face"
				viewBox="0 0 36 36"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
			>
				<circle cx="18" cy="18" r="17" />
				<circle cx="18" cy="24" r="6" />
				<g transform="translate(10 4)">
					<path d="M0 3 a 5 5 0 0 1 6 -1" />
					<line x1="0" y1="6" x2="6" y2="12" />
					<line x1="6" y1="6" x2="0" y2="12" />
				</g>
				<g transform="translate(20 4)">
					<path d="M0 2 a 5 5 0 0 1 6 1" />
					<line x1="0" y1="6" x2="6" y2="12" />
					<line x1="6" y1="6" x2="0" y2="12" />
				</g>
			</svg>
			<h1 className="error-boundary-title">Something has gone wrong</h1>
			<button
				className="button large error-boundary-retry"
				onClick={() =>
				{
					window.location.reload();
				}}
				type="button"
			>
				<span>Try again</span>
			</button>
			<div className="error-boundary-details">
				<div className="error-boundary-details-label">Error details</div>
				<div className="error-boundary-details-box">{message.slice(0, 200)}</div>
			</div>
		</div>
	);
}

/**
 * Error boundary component that catches JavaScript errors anywhere in the child
 * component tree, logs them, and displays a fallback UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState>
{
	constructor(props: ErrorBoundaryProps)
	{
		super(props);
		this.state =
		{
			hasError: false,
			error: null,
		};
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState
	{
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void
	{
		console.error("ErrorBoundary caught an error:", error, errorInfo);
	}

	render(): ReactNode
	{
		const {hasError, error} = this.state;
		const {children, fallback} = this.props;

		if (hasError)
		{
			if (fallback != null)
			{
				return fallback;
			}

			return <FatalErrorScreen message={error?.message ?? "An unexpected error occurred"} />;
		}

		return children;
	}
}
