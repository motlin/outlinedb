import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {FocusEvent, KeyboardEvent} from "react";
import {createPortal} from "react-dom";
import {canApply, canUnlink, normalizeLinkHref} from "../link-popup-model.js";
import {Button} from "./button.js";
import {domkitInputClass} from "./domkit-input.js";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";

const INPUT_CLASS = `${domkitInputClass()} desktop:w-[420px]`;
const LABEL_CLASS = "text-left text-s mobile:text-base font-medium";

export interface LinkPopupProps
{
	/** The link's current text, and its href (empty for a new link). */
	text: string;
	href: string;
	/** The span's bottom-left corner in page coordinates. */
	position: readonly [number, number];
	onApply: (link: {text: string; href: string}) => void;
	onUnlink: () => void;
	/** Cancel, Escape, and focus leaving all close the popup the same way. */
	onCancel: () => void;
}

/**
 * Upstream's ⌘K link popup (`LINK_POPUP`, form `Io1`): a Text and a Link field with Cancel, Unlink and Apply. The href
 * field takes focus for a new link, the text field (fully selected) for an existing one.
 */
export function LinkPopup({
	text: initialText,
	href: initialHref,
	position,
	onApply,
	onUnlink,
	onCancel,
}: LinkPopupProps)
{
	const [text, setText] = useState(initialText);
	const [href, setHref] = useState(initialHref);
	const textRef = useRef<HTMLInputElement>(null);
	const hrefRef = useRef<HTMLInputElement>(null);
	const applicable = canApply(text, href);

	useLayoutEffect(() =>
	{
		const input = initialHref === "" ? hrefRef.current : textRef.current;
		input?.focus();
		input?.select();
	}, [initialHref]);

	useEffect(() =>
	{
		const onKeyDown = (event: globalThis.KeyboardEvent) =>
		{
			if (event.key === "Escape")
			{
				event.stopImmediatePropagation();
				onCancel();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () =>
		{
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onCancel]);

	const apply = () =>
	{
		if (applicable)
		{
			onApply(
				{
					text: text.trim(),
					href: normalizeLinkHref(href),
				},
			);
		}
	};
	const handleKeyDown = (event: KeyboardEvent) =>
	{
		if (event.key === "Enter")
		{
			event.stopPropagation();
			event.preventDefault();
			apply();
		}
	};
	const handleBlur = (event: FocusEvent<HTMLElement>) =>
	{
		if (!event.currentTarget.contains(event.relatedTarget))
		{
			onCancel();
		}
	};

	return createPortal(
		<Flyout
			expanded
			position={position}
			align={FlyoutAlign.Left}
			maxWidth={500}
			className="px-l pt-xl pb-l text-center"
		>
			<div>
				<div
					tabIndex={-1}
					style={
					{
						outline: "none",
					}}
					onBlur={handleBlur}
				>
					{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- upstream's form handles Enter on its wrapper */}
					<div className="flex flex-col gap-l" onKeyDown={handleKeyDown}>
						<div className="flex flex-col gap-m">
							<p className={LABEL_CLASS}>Text</p>
							<div className="flex flex-col w-full">
								<input
									ref={textRef}
									className={INPUT_CLASS}
									name="text"
									type="text"
									autoComplete="off"
									value={text}
									onChange={(event) =>
									{
										setText(event.currentTarget.value);
									}}
								/>
							</div>
						</div>
						<div className="flex flex-col gap-m">
							<p className={LABEL_CLASS}>Link</p>
							<div className="flex flex-col w-full">
								<input
									ref={hrefRef}
									className={INPUT_CLASS}
									name="href"
									type="text"
									autoComplete="off"
									value={href}
									onChange={(event) =>
									{
										setHref(event.currentTarget.value);
									}}
								/>
							</div>
						</div>
						<div>
							<div className="flex justify-between gap-2xl">
								<Button variant="secondary" onClick={onCancel}>
									Cancel
								</Button>
								<div className="flex flex-row gap-m mobile:gap-l">
									{canUnlink(text) ? (
										<Button variant="secondary" onClick={onUnlink}>
											Unlink
										</Button>
									) : null}
									<Button variant="primary" disabled={!applicable} onClick={apply}>
										Apply
									</Button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</Flyout>,
		document.body,
	);
}
