import type {Meta, StoryObj} from "@storybook/react-vite";

import type {NodeResponse} from "../../../node-types.js";
import {ItemMenuBody} from "../node-context-menu.js";

const HOUR = 60 * 60;
const STORY_NOW = Math.floor(Date.now() / 1000);

/** The item-menu body rendered inline (without the ButtonMenu portal) inside the flyout surface. */
function ItemMenuInline({isCompleted = false, modifiedAt = true}: {isCompleted?: boolean; modifiedAt?: boolean})
{
	const now = STORY_NOW;
	const node: NodeResponse =
	{
		id: "story",
		parent_id: null,
		name: "Story node",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: now - 48 * HOUR,
		modifiedAt: modifiedAt ? now - HOUR : null,
		completedAt: isCompleted ? now : null,
	};
	return (
		<div
			className="wf-menu flex flex-col border border-solid border-primary font-normal text-xs rounded-md bg-primary shadow-md overflow-x-hidden flyout menu"
			style={
			{
				maxWidth: 300,
				padding: 5,
			}}
		>
			<div className="scroller overflow-y-auto">
				<ItemMenuBody
					actions={
					{
						onComplete: () =>
						{
						},
						onAddNote: () =>
						{
						},
						onAddDate: () =>
						{
						},
						onPresent: () =>
						{
						},
						onMoveTo: () =>
						{
						},
						onMirrorTo: () =>
						{
						},
						onMirror: () =>
						{
						},
						onDetachMirror: () =>
						{
						},
						onDuplicate: () =>
						{
						},
						onExport: () =>
						{
						},
						onCopyLink: () =>
						{
						},
						onMakeTemplate: () =>
						{
						},
						onOpenInPane: () =>
						{
						},
						onDelete: () =>
						{
						},
						onExpandAll: () =>
						{
						},
						onCollapseAll: () =>
						{
						},
						onSort: () =>
						{
						},
					}}
					node={node}
					onClose={() =>
					{
					}}
					onShowMirrors={() =>
					{
					}}
				/>
			</div>
		</div>
	);
}

const meta: Meta<typeof ItemMenuInline> =
{
	title: "Components/NodeContextMenu",
	component: ItemMenuInline,
	parameters:
	{
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes:
	{
		isCompleted:
		{
			control: "boolean",
			description: "Whether the node is completed (changes Complete/Uncomplete label)",
		},
		modifiedAt:
		{
			control: "boolean",
			description: "Whether the node has a modified time (shows the Changed/Created footer)",
		},
	},
	args: {},
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story =
{
	args:
	{
		isCompleted: false,
		modifiedAt: true,
	},
};

export const CompletedNode: Story =
{
	args:
	{
		isCompleted: true,
		modifiedAt: true,
	},
};
