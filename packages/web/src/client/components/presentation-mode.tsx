import {useCallback, useEffect, useMemo} from "react";
import {useShallow} from "zustand/react/shallow";
import {useChildren, useNode} from "../hooks/use-nodes.js";
import {useOutlineStore} from "../stores/outline.js";

/**
 * Single slide component displaying one node.
 * Shows the node name in large text, centered.
 */
function Slide({
	nodeName,
	parentName,
	isFirstSlide,
}: {
	nodeName: string;
	parentName: string | null;
	isFirstSlide: boolean;
}) {
	return (
		<div className="presentation-slide">
			{isFirstSlide ? (
				<div className="presentation-title-slide">
					<h1 className="presentation-title-text">{nodeName || "Untitled"}</h1>
				</div>
			) : (
				<div className="presentation-content-slide">
					{parentName && <div className="presentation-parent-name">{parentName}</div>}
					<h2 className="presentation-slide-name">{nodeName || "Untitled"}</h2>
				</div>
			)}
		</div>
	);
}

/**
 * Navigation controls for presentation mode.
 */
function NavigationControls({
	currentIndex,
	totalSlides,
	onPrevious,
	onNext,
}: {
	currentIndex: number;
	totalSlides: number;
	onPrevious: () => void;
	onNext: () => void;
}) {
	const canGoPrevious = currentIndex > 0;
	const canGoNext = currentIndex < totalSlides - 1;

	return (
		<div className="presentation-navigation">
			<button
				aria-label="Previous slide"
				className={`presentation-nav-button ${canGoPrevious ? "" : "disabled"}`}
				disabled={!canGoPrevious}
				onClick={onPrevious}
				type="button"
			>
				<svg fill="currentColor" height="20" viewBox="0 0 320 512" width="20">
					<path d="M52.7 267.3c-6.2-6.2-6.2-16.4 0-22.6l160-160c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6L86.6 256 235.3 404.7c6.2 6.2 6.2 16.4 0 22.6s-16.4 6.2-22.6 0l-160-160z" />
				</svg>
			</button>
			<button
				aria-label="Next slide"
				className={`presentation-nav-button ${canGoNext ? "" : "disabled"}`}
				disabled={!canGoNext}
				onClick={onNext}
				type="button"
			>
				<svg fill="currentColor" height="20" viewBox="0 0 320 512" width="20">
					<path d="M267.3 244.7c6.2 6.2 6.2 16.4 0 22.6l-160 160c-6.2 6.2-16.4 6.2-22.6 0s-6.2-16.4 0-22.6L233.4 256 84.7 107.3c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0l160 160z" />
				</svg>
			</button>
		</div>
	);
}

/**
 * Header bar for presentation mode with close button.
 */
function PresentationHeader({parentName, onClose}: {parentName: string | null; onClose: () => void}) {
	return (
		<div className="presentation-header">
			<div className="presentation-header-title">{parentName}</div>
			<div className="presentation-header-toolbar">
				<button
					aria-label="Exit presentation"
					className="presentation-close-button"
					onClick={onClose}
					type="button"
				>
					<svg fill="currentColor" height="18" viewBox="0 0 448 512" width="18">
						<path d="M420.7 36.7c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6L246.6 256 443.3 452.7c6.2 6.2 6.2 16.4 0 22.6s-16.4 6.2-22.6 0L224 278.6 27.3 475.3c-6.2 6.2-16.4 6.2-22.6 0s-6.2-16.4 0-22.6L201.4 256 4.7 59.3c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0L224 233.4 420.7 36.7z" />
					</svg>
				</button>
			</div>
		</div>
	);
}

/**
 * Full-screen presentation mode component.
 * Displays nodes as slides that can be navigated with arrow keys or buttons.
 *
 * Based on production Workflowy presentation mode:
 * - First slide shows the zoomed node title
 * - Subsequent slides show each child node
 * - Arrow key navigation
 * - Close with X button or Escape key
 */
export function PresentationMode() {
	const {presentationOpen, presentationContext, closePresentation, nextSlide, previousSlide} = useOutlineStore(
		useShallow((state) => ({
			presentationOpen: state.presentationOpen,
			presentationContext: state.presentationContext,
			closePresentation: state.closePresentation,
			nextSlide: state.nextSlide,
			previousSlide: state.previousSlide,
		})),
	);

	// Fetch the root node of the presentation
	const {data: rootNode} = useNode(presentationContext?.nodeId ?? null);

	// Fetch children of the root node
	const {data: children} = useChildren(presentationContext?.nodeId ?? null);

	// Build slides array: first slide is the root node, then each child
	const slides = useMemo(() => {
		if (!rootNode) {
			return [];
		}

		const slideList = [{id: rootNode.id, name: rootNode.name ?? "", isTitle: true}];

		if (children) {
			for (const child of children) {
				slideList.push({id: child.id, name: child.name ?? "", isTitle: false});
			}
		}

		return slideList;
	}, [rootNode, children]);

	const currentIndex = presentationContext?.currentSlideIndex ?? 0;
	const currentSlide = slides[currentIndex];

	// Keyboard navigation
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (!presentationOpen) {
				return;
			}

			switch (event.key) {
				case "ArrowRight":
				case "ArrowDown":
				case " ": {
					event.preventDefault();
					if (currentIndex < slides.length - 1) {
						nextSlide();
					}
					break;
				}
				case "ArrowLeft":
				case "ArrowUp": {
					event.preventDefault();
					if (currentIndex > 0) {
						previousSlide();
					}
					break;
				}
				case "Escape": {
					event.preventDefault();
					closePresentation();
					break;
				}
			}
		},
		[presentationOpen, currentIndex, slides.length, nextSlide, previousSlide, closePresentation],
	);

	// Register keyboard handler
	useEffect(() => {
		if (presentationOpen) {
			document.addEventListener("keydown", handleKeyDown);
			// Prevent body scroll when presentation is open
			document.body.style.overflow = "hidden";
		}

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "";
		};
	}, [presentationOpen, handleKeyDown]);

	// Don't render if not open
	if (!presentationOpen || !presentationContext) {
		return null;
	}

	const parentName = currentIndex > 0 ? (rootNode?.name ?? null) : null;

	return (
		<dialog aria-label="Presentation mode" aria-modal="true" className="presentation-overlay" open>
			<PresentationHeader onClose={closePresentation} parentName={parentName} />

			<div className="presentation-content">
				{currentSlide !== undefined && (
					<Slide isFirstSlide={currentSlide.isTitle} nodeName={currentSlide.name} parentName={parentName} />
				)}
			</div>

			<NavigationControls
				currentIndex={currentIndex}
				onNext={nextSlide}
				onPrevious={previousSlide}
				totalSlides={slides.length}
			/>

			<div className="presentation-footer">Made with OutlineDB</div>
		</dialog>
	);
}
