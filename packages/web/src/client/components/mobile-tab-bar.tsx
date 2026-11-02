import {useQueryClient} from "@tanstack/react-query";
import {useCreateNode, useChildren} from "../hooks/use-nodes.js";
import {useNavigateToToday} from "../hooks/use-navigate-to-today.js";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import {isAndroid} from "../is-mobile.js";
import {tabBarClassName} from "../mobile-tab-bar-model.js";
import {cachedResolvedId} from "../node-cache.js";
import {stepNav} from "../navigation.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {useSheetStore} from "../stores/sheet.js";
import {lastChildShapeLayout, planAddChild} from "../tree-ops.js";
import type {FaIconKey} from "./fa-icons.js";
import {FaIcon} from "./fa-icons.js";

export interface TabBarButton
{
	id: "menu" | "back" | "add" | "today" | "search";
	icon: FaIconKey;
	enabled: boolean;
	onPress: () => void;
}

export interface MobileTabBarViewProps
{
	userAgent: string;
	buttons: readonly TabBarButton[];
	/** A sheet is open: upstream's `hideForSheetView` fades the bar out. */
	sheetOpen: boolean;
}

/** Upstream's bottom tab bar. Android has no back slot; an unavailable command is drawn at half opacity and ignored. */
export function MobileTabBarView({userAgent, buttons, sheetOpen}: MobileTabBarViewProps)
{
	const shown = isAndroid(userAgent) ? buttons.filter((button) => button.id !== "back") : buttons;
	return (
		<div
			className={tabBarClassName(userAgent)}
			style={
			{
				opacity: sheetOpen ? 0 : 1,
			}}
		>
			{shown.map((button) => (
				// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch tab: tapping runs its command
				<div
					key={button.id}
					className="tab-bar-button w-[44px] h-[44px] flex items-center justify-center"
					data-tab={button.id}
					style={
						button.enabled
							? undefined
							:
								{
									opacity: 0.5,
								}
					}
					onClick={() =>
					{
						if (button.enabled)
						{
							button.onPress();
						}
					}}
				>
					<FaIcon icon={button.icon} size="lg" />
				</div>
			))}
		</div>
	);
}

/** Moves the caret into the search form: shows it, then focuses its input once it is displayed. */
function focusMobileSearch(): void
{
	useOutlineStore.getState().focusSearch(null);
	requestAnimationFrame(() =>
	{
		document.querySelector<HTMLInputElement>(".newMobileSearchBox")?.focus();
	});
}

/** The tab bar wired to the leftbar, history, add-child, today and search commands. */
export function MobileTabBar()
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const navigateToToday = useNavigateToToday();
	const createNode = useCreateNode();
	const zoomedId = useOutlineStore(activeZoomedId);
	const {data: children} = useChildren(zoomedId);
	const canGoBack = useOutlineStore(
		(state) => (state.panes.length > 0 ? state.mainPaneHistory.back : state.nav.back).length > 0,
	);
	const editing = useOutlineStore((state) => state.editingId !== null);
	const searchOpen = useOutlineStore((state) => state.searchFocused);
	const sheetOpen = useSheetStore((state) => state.sheet !== null);
	// While editing, the keyboard accessory owns the bottom; while the search form is focused, its helpers do.
	if (editing || searchOpen)
	{
		return null;
	}
	const addChild = () =>
	{
		const existing = children ?? [];
		const plan = planAddChild(
			{
				childCount: existing.length,
				zoomedId,
				shapeLayout: lastChildShapeLayout(queryClient, zoomedId, existing.at(-1)),
			},
		);
		const id = crypto.randomUUID();
		createNode.mutate(
			{
				id,
				parent_id: plan.parent_id,
				name: plan.name,
				index: 0,
				...(plan.layoutMode === null
					? {}
					:
						{
							layoutMode: plan.layoutMode,
						}),
			},
		);
		useOutlineStore.getState().resumeEditing(id, 0);
	};
	const buttons: TabBarButton[] = [
		{
			id: "menu",
			icon: "fal:bars",
			enabled: true,
			onPress: () =>
			{
				useOutlineStore.getState().toggleLeftBar();
			},
		},
		{
			id: "back",
			icon: "fal:chevron-left",
			enabled: canGoBack,
			onPress: () =>
			{
				stepNav(navigate, "back", (locationId) => cachedResolvedId(queryClient, locationId));
			},
		},
		{
			id: "add",
			icon: "fal:plus",
			enabled: true,
			onPress: addChild,
		},
		{
			id: "today",
			icon: "fal:calendar-day",
			enabled: true,
			onPress: () =>
			{
				void navigateToToday();
			},
		},
		{
			id: "search",
			icon: "fas:magnifying-glass",
			enabled: true,
			onPress: focusMobileSearch,
		},
	];
	return <MobileTabBarView userAgent={navigator.userAgent} buttons={buttons} sheetOpen={sheetOpen} />;
}
