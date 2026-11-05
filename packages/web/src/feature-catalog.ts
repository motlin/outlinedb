/**
 * The account feature catalog: the 20 Settings > Features rows upstream shows (measured 2026-10-23, same order and
 * copy) and the enabled dict of the account the clone tracks (measured 2026-10-26). Shared by the server, which answers
 * them when there is no internal API or stored dict (a standalone OutlineDB account), and the client fallback.
 */

export interface VisibleFeature {
	codename: string;
	name: string;
	label: string | null;
	description: string | null;
}

export const VISIBLE_FEATURES: readonly VisibleFeature[] = [
	{
		codename: "beta_redirect",
		name: "Workflowy Labs",
		label: null,
		description:
			"Give us feedback on new Workflowy features as they come out! Be the first to know about new features and help our team improve the product.",
	},
	{
		codename: "open_links_in_desktop",
		name: "Open links in desktop app",
		label: null,
		description:
			"When opening links in the browser, also open them in the desktop app. THIS DOES NOT APPLY TO MOBILE APPS.",
	},
	{
		codename: "dates",
		name: "Dates",
		label: null,
		description: "Adding dates, Searching for dates, Date ranges",
	},
	{
		codename: "full_width_page",
		name: "Full width page",
		label: null,
		description:
			"Lines wrapping getting you down? Turn this on, and WorkFlowy will spread luxuriously across all the screen space you give it.",
	},
	{
		codename: "templates",
		name: "Templates",
		label: null,
		description: "This lets you create and reuse complex structures in a convenient way",
	},
	{
		codename: "bdl",
		name: "Backlinks",
		label: null,
		description:
			"When you create an internal link to another part of your Workflowy, it is tracked in a 'Backlinks' section at the bottom of the destination link/bullet. \r\nUse [[inline linking]] or copy/paste URLs to create internal links.",
	},
	{
		codename: "keep_keyboard_on_scroll",
		name: "Keep Mobile Keyboard on Scroll",
		label: null,
		description:
			"Keeps the soft keyboard open when you scroll the content above. Applicable only to mobile devices.",
	},
	{
		codename: "rich_tags",
		name: "Rich tags",
		label: null,
		description:
			"Allows emojis and some other characters in tags. Note: page reload is required to apply the changes to all your tags.",
	},
	{
		codename: "always_visible_controls",
		name: "Always show expand/collapse arrows",
		label: null,
		description: "Show expand/collapse buttons at all times, not just on hover. Page reload required.",
	},
	{
		codename: "update_notifications",
		name: "All updates",
		label: "LABS",
		description:
			"Get updates info in a shared space.\r\n\r\nNote: Page reload is required in order to make the feature work correctly.",
	},
	{
		codename: "conversations",
		name: "Fractal Comments",
		label: null,
		description:
			"Leave comments on any node in Workflowy. Comments have infinite threading so you can have deep, open-ended or infinitely detailed conversations.",
	},
	{
		codename: "dashboards",
		name: "Dashboard layout",
		label: "LABS",
		description:
			"Adds a new Dashboard item type. This is an EARLY prototype, and IS NOT BEING ACTIVELY DEVELOPED.  Use at your own risk. NOTE: Page reload required to apply the feature toggle.",
	},
	{
		codename: "ai",
		name: "Workflowy AI",
		label: "LABS",
		description:
			"Ask questions about your notes, discover new insights, and turn your ideas into action. (note: page reload is required).",
	},
	{
		codename: "present",
		name: "Instant Presentations",
		label: "LABS",
		description:
			"Turn any outline into a presentation instantly by pressing the play button in the menu bar.\r\nPage reload required.",
	},
	{
		codename: "nested_search",
		name: "Nested search",
		label: null,
		description:
			"Use '>' to build nested searches. \r\n\"is:todo > #high\" searches for items with #high that are descendants of 'is:todo' items at any depth.",
	},
	{
		codename: "markdown_pasting",
		name: "Recognize markdown pasting",
		label: null,
		description:
			"If the text you paste looks like Markdown, do our best to convert it to WorkFlowy formatting options",
	},
	{
		codename: "calendar_node",
		name: "Calendar",
		label: null,
		description:
			"Show a Calendar node and Today button in the header and sidebar to plan, journal, and take notes.",
	},
	{
		codename: "numbered_list",
		name: "Numbered List",
		label: null,
		description:
			"Turn a bullet into a numbered list that automatically renumbers when you add, delete, or reorder nodes.",
	},
	{
		codename: "table",
		name: "Tables",
		label: null,
		description:
			"Organise your data in rows and columns, making it easy to compare, sort, and manage lists of things.",
	},
	{
		codename: "side_pane",
		name: "Panes",
		label: null,
		description:
			"Open nodes in separate panes to view and work with multiple parts of your WorkFlowy side by side.",
	},
];

/** Dashboards, conversations and ai are off; every other visible flag is on. */
export const DEFAULT_FEATURES: Readonly<Record<string, true>> = {
	always_visible_controls: true,
	bdl: true,
	beta_redirect: true,
	calendar_node: true,
	dates: true,
	full_width_page: true,
	keep_keyboard_on_scroll: true,
	markdown_pasting: true,
	nested_search: true,
	numbered_list: true,
	open_links_in_desktop: true,
	present: true,
	rich_tags: true,
	side_pane: true,
	table: true,
	templates: true,
	update_notifications: true,
};
