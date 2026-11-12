import {Fragment, useEffect, useRef} from "react";
import {crumbLabel as formatCrumbLabel} from "../crumb-label.js";
import {useCrumbZoomOut} from "../crumb-zoom.js";
import {useAccount} from "../hooks/use-account.js";
import type {MentionAccount} from "../mention-pills.js";
import type {NodeResponse} from "../../node-types.js";
import {useAncestors} from "../hooks/use-nodes.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {useDayPrefix} from "../hooks/use-calendar-settings.js";
import {homeButtonOpacity, truncateCrumb} from "../mobile-crumbs.js";
import {useNodeNavigation} from "../navigation.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {Sheet} from "../stores/sheet.js";
import {FaIcon} from "./fa-icons.js";
import {MobileSearchForm} from "./mobile-search-form.js";

function crumbText(
	node: Pick<NodeResponse, "name" | "calendar">,
	options:
	{
		dateFormat: string;
		timeFormat: string;
		dayPrefix: boolean;
		account: MentionAccount;
	},
): string
{
	return formatCrumbLabel(
		node.name ?? "",
		{
			now: new Date(),
			dateFormat: options.dateFormat,
			timeFormat: options.timeFormat,
			dayDateId: node.calendar?.level === "day" ? node.calendar.dateId : null,
			dayPrefix: options.dayPrefix,
			account: options.account,
		},
	);
}

export interface MobileCrumb
{
	id: string;
	label: string;
}

export interface MobileBreadcrumbsViewProps
{
	/** Ancestors below the root, ending with the current node. */
	crumbs: readonly MobileCrumb[];
	searching: boolean;
	onHome: () => void;
	onCrumb: (id: string) => void;
	onKebab: () => void;
}

const TOP_BAR_CLASS =
	"wf-header topBar fixed z-1 top-0 inset-x-0 flex flex-col-reverse pt-sat pl-sal pr-sar bg-primary";
const CRUMBS_CLASS =
	"h-[var(--wf-header-height)] flex items-stretch justify-start overflow-hidden bg-primary MobileBreadcrumbs";
const HOME_CLASS =
	"h-full shrink-0 flex items-center justify-center transition-opacity duration-100 ease-base homeButton";
const CHEVRON_CLASS = "w-s h-full pl-s flex items-center pointer-events-none";
const SCROLLER_CLASS =
	"relative h-full flex-[1_1_auto] flex items-stretch flex-nowrap overflow-x-auto [--webkit-overflow-scrolling:touch]";
const KEBAB_CLASS = "h-full grow-0 shrink-0 basis-[44px] flex items-center justify-center text-tertiary";

/** Upstream's `Xw4` MobileBreadcrumbs: home button, a scrolling italic crumb trail and the kebab. */
export function MobileBreadcrumbsView({crumbs, searching, onHome, onCrumb, onKebab}: MobileBreadcrumbsViewProps)
{
	const scroller = useRef<HTMLDivElement>(null);
	const lastId = crumbs.at(-1)?.id;
	const previousId = useRef(lastId);
	// On a zoom change the trail scrolls to show the new crumb after 200ms, like upstream.
	useEffect(() =>
	{
		const changed = previousId.current !== lastId;
		previousId.current = lastId;
		const timer = changed
			? setTimeout(() =>
				{
					scroller.current?.scrollBy(
						{
							left: 500,
							behavior: "smooth",
						},
					);
				}, 200)
			: undefined;
		return () =>
		{
			clearTimeout(timer);
		};
	}, [lastId]);
	return (
		<div className={CRUMBS_CLASS}>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch control: tapping goes home */}
			<div
				className={HOME_CLASS}
				style={
				{
					width: 48,
					opacity: homeButtonOpacity(
						{
							atRoot: crumbs.length === 0,
							searching,
						},
					),
				}}
				onClick={onHome}
			>
				<FaIcon icon="fal:house" size="lg" />
			</div>
			{crumbs.length > 0 && (
				<div
					className="relative w-s pl-s flex items-center pointer-events-none"
					style={
					{
						left: -8,
					}}
				>
					<FaIcon icon="fal:chevron-right" size="xs" />
				</div>
			)}
			<div ref={scroller} className={SCROLLER_CLASS}>
				{crumbs.map((crumb, index) =>
				{
					const current = index === crumbs.length - 1;
					return (
						<Fragment key={crumb.id}>
							<span className="pr-s flex-none flex items-center italic">
								{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch crumb: tapping navigates */}
								<span
									className={current ? "flex-none" : "flex-none underline"}
									style={
									{
										color: "var(--wf-text-tertiary)",
									}}
									onClick={
										current
											? undefined
											: () =>
												{
													onCrumb(crumb.id);
												}
									}
								>
									{truncateCrumb(crumb.label)}
								</span>
							</span>
							{!current && (
								<div className={CHEVRON_CLASS}>
									<FaIcon icon="fal:chevron-right" size="xs" />
								</div>
							)}
						</Fragment>
					);
				})}
			</div>
			{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch control: tapping opens the more menu */}
			<div
				className={KEBAB_CLASS}
				style={
				{
					marginRight: 4,
				}}
				onClick={onKebab}
			>
				<FaIcon icon="fal:ellipsis-vertical" size="lg" className="text-icon" />
			</div>
		</div>
	);
}

/** Upstream's phone shell top (`.topBar`): the crumbs, and the search form that renders above them. */
export function MobileTopBar()
{
	const zoomedId = useOutlineStore(activeZoomedId);
	const searching = useOutlineStore((state) => state.searchQuery !== "");
	const {data: ancestors} = useAncestors(zoomedId);
	const {navigateToNode, cancelSearch} = useNodeNavigation();
	const crumbZoomOut = useCrumbZoomOut();
	const {dateFormat, timeFormat} = useDateSettings();
	const account = useAccount();
	const dayPrefix = useDayPrefix(ancestors?.find((node) => node.calendar?.root === true)?.calendar?.dayPrefix);
	const crumbs: MobileCrumb[] =
		zoomedId === null || ancestors === undefined
			? []
			: ancestors.map((node) => (
				{
					id: node.id,
					label: crumbText(
						node,
						{
							dateFormat,
							timeFormat,
							dayPrefix,
							account,
						},
					),
				}));
	const leaveSearch = () =>
	{
		if (searching)
		{
			cancelSearch();
		}
	};
	return (
		<div className={TOP_BAR_CLASS}>
			<MobileBreadcrumbsView
				crumbs={crumbs}
				searching={searching}
				onHome={() =>
				{
					leaveSearch();
					navigateToNode(null);
				}}
				onCrumb={(id) =>
				{
					leaveSearch();
					const go = () =>
					{
						crumbZoomOut(
							crumbs.map((crumb) => crumb.id),
							id,
						);
					};
					if ("startViewTransition" in document)
					{
						document.startViewTransition(
							{
								update: go,
								types: ["backwards"],
							},
						);
					}
					else
					{
						go();
					}
				}}
				onKebab={() =>
				{
					Sheet.set("more-menu");
				}}
			/>
			<MobileSearchForm />
		</div>
	);
}
