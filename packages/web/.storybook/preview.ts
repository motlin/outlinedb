import type {Preview} from "@storybook/react-vite";

import "../src/client/styles.css";

const preview: Preview =
{
	parameters:
	{
		controls:
		{
			matchers:
			{
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		backgrounds:
		{
			default: "light",
			values: [
				{
					name: "light",
					value: "#ffffff",
				},
				{
					name: "dark",
					value: "#1a1a1a",
				},
			],
		},
	},
	decorators: [
		(Story, context) =>
		{
			// Apply theme based on selected background
			const isDark = context.globals.backgrounds?.value === "#1a1a1a";
			document.body.classList.remove("_theme-default", "_theme-dark");
			document.body.classList.add(isDark ? "_theme-dark" : "_theme-default");
			return Story();
		},
	],
};

export default preview;
