import {useEffect, useState} from "react";
import type {ReactNode} from "react";

/** Upstream's popup level for the sheet scrim. */
const SCRIM_Z_INDEX = 299;

const SCRIM_CLASS = "modal-scrim fixed inset-0 bg-[var(--wf-black-opaque-20)] transition-opacity duration-200";
const ATTACHED_CLASS = "fixed right-0 left-0 bottom-0";
const PANEL_CLASS =
	"wf-menu text-primary relative bg-primary overflow-y-auto rounded-tl-s rounded-tr-s max-h-[66vh] shadow-[rgba(0,0,0,0.2)_0px_2px_20px] box-border pb-3xl mobile-menu";

interface MobileMenuProps
{
	children?: ReactNode;
	onClose: () => void;
	/** Upstream's sticky `header-row` (a tap closes the sheet); the more-menu hides it. */
	header?: boolean;
}

/**
 * Upstream's `MobileMenu` (`R34`): a scrim and a bottom-attached panel that slides in over 0.4s. Tapping the scrim or
 * the header row closes it.
 */
export function MobileMenu({children, onClose, header = true}: MobileMenuProps)
{
	const [entered, setEntered] = useState(false);
	useEffect(() =>
	{
		const frame = requestAnimationFrame(() =>
		{
			setEntered(true);
		});
		return () =>
		{
			cancelAnimationFrame(frame);
		};
	}, []);
	return (
		<>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch scrim: dismissing is a tap */}
			<div
				className={SCRIM_CLASS}
				style={
				{
					zIndex: SCRIM_Z_INDEX,
				}}
				onClick={onClose}
			/>
			<div
				className={ATTACHED_CLASS}
				style={
				{
					zIndex: 300,
					transition: "bottom 0.4s ease",
					bottom: entered ? 0 : -window.screen.height,
				}}
			>
				<div className={PANEL_CLASS}>
					{header && (
						// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch handle: closing is a tap
						<div className="header-row h-xl sticky top-0 bg-primary" onClick={onClose} />
					)}
					{children}
				</div>
			</div>
		</>
	);
}
