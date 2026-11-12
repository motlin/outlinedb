import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";

import {ExpandTriangle} from "./primitives.js";

const meta: Meta<typeof ExpandTriangle> =
{
	title: "Primitives/ExpandTriangle",
	component: ExpandTriangle,
	parameters:
	{
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes:
	{
		isExpanded:
		{
			control: "boolean",
			description: "Whether the node is expanded (triangle points down)",
		},
	},
	args:
	{
		onClick: fn<() => void>(),
	},
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story =
{
	args:
	{
		isExpanded: false,
	},
};

export const Expanded: Story =
{
	args:
	{
		isExpanded: true,
	},
};
