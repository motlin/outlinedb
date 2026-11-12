import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";

import {MenuItem, MenuSeparator} from "../flyout/menu-item.js";

const meta: Meta<typeof MenuItem> =
{
	title: "Components/MenuItem",
	component: MenuItem,
	parameters:
	{
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes:
	{
		label:
		{
			control: "text",
			description: "The text label for the menu item",
		},
		disabled:
		{
			control: "boolean",
			description: "Whether the menu item is disabled",
		},
		shortcut:
		{
			control: "text",
			description: "Keyboard shortcut shown at the end of the row",
		},
	},
	args:
	{
		onSelect: fn<() => void>(),
	},
	decorators: [
		(Story) => (
			<div
				className="wf-menu flex flex-col border border-solid border-primary text-xs rounded-md bg-primary shadow-md"
				style={
				{
					padding: 5,
					minWidth: 160,
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story =
{
	args:
	{
		label: "Complete",
		icon: "fal:check",
		shortcut: "⌘↵",
	},
};

export const Disabled: Story =
{
	args:
	{
		label: "Add note",
		icon: "fal:pencil",
		disabled: true,
	},
};

export const AllVariants: Story =
{
	render: () => (
		<>
			<MenuItem icon="fal:check" label="Complete" shortcut="⌘↵" />
			<MenuSeparator />
			<MenuItem icon="fal:trash-can" label="Delete" shortcut="⇧⌘⌫" />
			<MenuSeparator />
			<MenuItem icon="fal:up-right-and-down-left-from-center" label="Expand all" />
			<MenuItem icon="fal:down-left-and-up-right-to-center" label="Collapse all" />
		</>
	),
};
