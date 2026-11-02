import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";

import {MenuButton} from "./primitives.js";

const meta: Meta<typeof MenuButton> =
{
	title: "Components/MenuButton",
	component: MenuButton,
	parameters:
	{
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes:
	{
		isVisible:
		{
			control: "boolean",
			description: "Whether the menu button is visible (shown on hover/selection)",
		},
	},
	args:
	{
		onClick: fn<() => void>(),
	},
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story =
{
	args:
	{
		isVisible: true,
	},
};

export const Hidden: Story =
{
	args:
	{
		isVisible: false,
	},
};
