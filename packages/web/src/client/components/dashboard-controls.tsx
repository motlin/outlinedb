import {dashboardInsertIndex} from "../dashboard.js";
import {useCreateNode, useChildren} from "../hooks/use-nodes.js";
import {useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";
import {IconButton} from "./icon-button.js";

/** Upstream's top add button style (`ER4`): pinned to the title row's right edge. */
const DASHBOARD_TOP_BUTTON_STYLE =
{
	position: "absolute",
	right: 0,
	zIndex: 1,
	background: "var(--wf-background-quaternary)",
} as const;

function useAddCard(parentId: string, position: "top" | "bottom")
{
	const createNode = useCreateNode();
	const {data: children} = useChildren(parentId);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);
	return () =>
	{
		const id = crypto.randomUUID();
		createNode.mutate(
			{
				id,
				parent_id: parentId,
				name: "",
				index: dashboardInsertIndex(position, children?.length ?? 0),
			},
		);
		resumeEditing(id, 0);
	};
}

/** Upstream's `button.dashboard-button-top` in the zoomed dashboard's title: inserts a card at index 0. */
export function DashboardTopButton({parentId}: {parentId: string})
{
	const addCard = useAddCard(parentId, "top");
	return (
		<IconButton
			aria-label="Add new card"
			className="dashboard-button-top hover:!bg-[color-mix(in_srgb,var(--wf-background-quaternary)_85%,black)]"
			onClick={addCard}
			shape="square"
			size="lg"
			style={DASHBOARD_TOP_BUTTON_STYLE}
		>
			<FaIcon icon="fal:plus" />
		</IconButton>
	);
}

/** Upstream's `div.dashboard-add-button-bottom` (zoomed and inline): appends a card. */
export function DashboardBottomButton({parentId}: {parentId: string})
{
	const addCard = useAddCard(parentId, "bottom");
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's markup is a bare div; keyboard users add a card with Enter at the end of a card
		<div className="dashboard-add-button-bottom" onClick={addCard}>
			<FaIcon icon="fal:plus" />
		</div>
	);
}
