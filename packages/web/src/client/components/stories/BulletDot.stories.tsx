import type {Meta, StoryObj} from "@storybook/react-vite";

import {BulletDot} from "./primitives.js";

const meta: Meta<typeof BulletDot> =
{
	title: "Primitives/BulletDot",
	component: BulletDot,
	parameters:
	{
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes:
	{
		isCollapsed:
		{
			control: "boolean",
			description: "Whether the node is a collapsed parent (shows the halo)",
		},
		isMirror:
		{
			control: "boolean",
			description: "Whether the node is a mirror (diamond bullet)",
		},
	},
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story =
{
	args: {},
};

export const Collapsed: Story =
{
	args:
	{
		isCollapsed: true,
	},
};

export const Mirror: Story =
{
	args:
	{
		isMirror: true,
	},
};
