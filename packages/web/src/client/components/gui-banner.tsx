import {useEffect} from "react";
import type {BannerAction} from "../stores/banner.js";
import {bannerEscapeAction, hideBanner, useBannerStore} from "../stores/banner.js";
import {useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";

const SEARCH_INPUT_ID = "srch-input";

interface GuiBannerViewProps
{
	kind: "info" | "warn";
	text: string;
	title?: string;
	action?: BannerAction;
	/** The left bar's offset, so the banner sits beside it. */
	left: number;
	onClose: () => void;
	onAction: () => void;
}

export function GuiBannerView({kind, text, title, action, left, onClose, onAction}: GuiBannerViewProps)
{
	return (
		<div
			className="fixed right-0 top-[calc(var(--wf-header-height,0)+var(--safe-area-inset-top,0))] overflow-hidden z-10 print:hidden transition-[left] duration-250"
			style={
			{
				left,
			}}
		>
			<div
				className={`font-system flex items-center px-2xl py-ml text-s text-center transition-transform duration-300 ${kind === "warn" ? "bg-warning" : "bg-info"} [&_a]:text-[var(--wf-gray-800)] [&_a]:underline [&_a]:cursor-pointer [&_a.undelete]:font-bold`}
			>
				<div className="messageContent flex-grow flex-shrink leading-base">
					{title === undefined ? (
						text
					) : (
						<div>
							<strong>{title}</strong>
							<br />
							{text}
						</div>
					)}
					{action !== undefined && (
						// oxlint-disable-next-line jsx-a11y/anchor-is-valid, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup
						<a
							className="undelete"
							href="#"
							onClick={(event) =>
							{
								event.preventDefault();
								onAction();
							}}
						>
							{action.label}
						</a>
					)}
				</div>
				<FaIcon
					icon="fal:circle-xmark"
					className="cursor-pointer flex-[20px 0 0 ] h-[20px] opacity-70 hover:opacity-100"
					style={
					{
						flex: "20px 0 0",
					}}
					onClick={onClose}
				/>
			</div>
		</div>
	);
}

/** Mount once at the app root. Escape closes it (not from the search box) and claims the key. */
export function GuiBanner()
{
	const banner = useBannerStore((state) => state.banner);
	const left = useOutlineStore((state) => state.leftBarOffset());
	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent): void =>
		{
			if (event.key !== "Escape" || event.defaultPrevented)
			{
				return;
			}
			const action = bannerEscapeAction(
				{
					open: useBannerStore.getState().banner !== null,
					inSearchBox: document.activeElement?.id === SEARCH_INPUT_ID,
				},
			);
			if (action === "hide")
			{
				event.preventDefault();
				hideBanner();
			}
		};
		globalThis.addEventListener("keydown", onKeyDown);
		return () =>
		{
			globalThis.removeEventListener("keydown", onKeyDown);
		};
	}, []);
	if (banner === null)
	{
		return null;
	}
	return (
		<GuiBannerView
			kind={banner.kind}
			text={banner.text}
			{...(banner.title === undefined
				? {}
				:
					{
						title: banner.title,
					})}
			{...(banner.action === undefined
				? {}
				:
					{
						action: banner.action,
					})}
			left={left}
			onClose={hideBanner}
			onAction={() =>
			{
				banner.action?.run();
			}}
		/>
	);
}
