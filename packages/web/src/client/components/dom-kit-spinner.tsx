const COLOR = "#b7bcbf";
const CIRCLE =
{
	width: "16px",
	height: "16px",
	borderRadius: "8px",
	top: "4px",
	left: "4px",
} as const;

/** Upstream's `WF.DomKit.Spinner`: three concentric circles pulsing outward (keyframes in styles.css). */
export function DomKitSpinner()
{
	return (
		<div
			className="relative box-border"
			style={
			{
				width: "24px",
				height: "24px",
				display: "inline-block",
				marginLeft: "8px",
			}}
		>
			<div
				className="absolute box-border"
				style={
				{
					...CIRCLE,
					animation: "dom-kit-spinner-b4 1.5s infinite",
					border: `1px solid ${COLOR}`,
				}}
			/>
			<div
				className="absolute box-border border border-solid border-transparent"
				style={
				{
					...CIRCLE,
					animation: "dom-kit-spinner-b1 1.5s infinite",
					background: COLOR,
				}}
			/>
			<div
				className="absolute box-border"
				style={
				{
					...CIRCLE,
					animation: "dom-kit-spinner-b3 1.5s infinite",
					border: `1px solid ${COLOR}`,
				}}
			/>
		</div>
	);
}
