/**
 * Upstream's What's New entries (`z41` in wf-base.9d26a182115f), newest first: each id is its `changelog.read.<id>` key.
 * Generated from the bundle: each entry component's `I3` props (date, title) and its body as a tree of plain elements,
 * with upstream's `a6` images and `Bc` videos resolved to their https://beta.workflowy.com sources and
 * `WF.Urls.expand` links to https://workflowy.com. Regenerate rather than hand-edit.
 */

export type ChangelogTag = "h2" | "h3" | "p" | "ul" | "li" | "a" | "b" | "strong" | "code" | "br" | "img" | "video";

/** A body node: text, or an element with its React props and children. */
export type ChangelogNode =
	| string
	| {t: ChangelogTag; p?: Readonly<Record<string, string>>; c?: readonly ChangelogNode[]};

export interface ChangelogEntry {
	id: string;
	date: string;
	title: string;
	body: readonly ChangelogNode[];
}

export const CHANGELOG_ENTRIES: readonly ChangelogEntry[] = [
	{
		id: "september07_2026",
		date: "September 7th, 2026",
		title: "Update 2026.08: Panes and more...",
		body: [
			{
				t: "h3",
				c: ["Panes"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/panes.mp4",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Much requested, and finally here, you can now open Panes in Workflowy."],
					},
					{
						t: "li",
						c: [
							"Panes keep multiple parts of your Workflowy outline open side by side in the same window.",
						],
					},
					{
						t: "li",
						c: [
							"Keep your",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/plan-with-calendar",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Today"],
							},
							" ",
							"node open while you work, reference notes while drafting a document, or move nodes between parts of your outline without losing your place.",
						],
					},
					{
						t: "li",
						c: [
							"Each pane is a view of an existing node, not a duplicate. Any edits you make in a pane update the original everywhere it appears.",
						],
					},
					{
						t: "li",
						c: [
							"To create a new pane, press the 'New pane' button in the header. To open a specific node, hold Alt (Option on Mac) and click its bullet, choose Open in Pane from the node menu, or type ",
							{
								t: "code",
								c: ["/open in pane"],
							},
							".",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Note:"],
							},
							" Panes are available in desktop browsers and the Workflowy desktop apps. No mobile support (yet).",
						],
					},
					{
						t: "li",
						c: [
							"For more, including keyboard shortcuts, visit the",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/panes",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Panes help doc"],
							},
							".",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Improvements"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/tables-shortcut.mp4",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/tables",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Tables"],
							},
							": Move a row using the standard Move Up and Move Down",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/hotkeys",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["keyboard shortcuts"],
							},
							".",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Inline code:"],
							},
							" Typing two spaces at the end of inline code returns you to regular text.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/dividers",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Dividers"],
							},
							": Pressing Delete immediately after typing a Divider title no longer turns it back into a bullet.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/files-images#view-pdf-files",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["PDF previews"],
							},
							": Closing a PDF no longer leaves a weird black rectangle over Workflowy.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/search",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Search"],
							},
							": Use ",
							{
								t: "code",
								c: ["has:children"],
							},
							" to find nodes with child nodes.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/plan-with-calendar",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Calendar"],
							},
							": Move to Date is now available from the node menu.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/google-calendar",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Google Calendar"],
							},
							": Sync recovers more reliably from temporary connection failures.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/apps-devices",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Mobile"],
							},
							": The indent, outdent, undo, and redo keyboard accessory buttons now update immediately. No more lag.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/settings",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Settings"],
							},
							": A redesigned Settings screen brings clearer sections, consistent controls, and simpler navigation.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Billing:"],
							},
							" If a subscription payment is delayed, Workflowy now recognizes the existing subscription and prevents you from starting another checkout.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["iOS:"],
							},
							" Upgrade to Pro directly from Settings.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Login:"],
							},
							" Password users can",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/accounts/switch-to-login-code/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["switch back to emailed login codes"],
							},
							".",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Help Documents"],
			},
			{
				t: "p",
				c: [
					"We've reorganized the",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/help",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Workflowy Help Center"],
					},
					" ",
					"around common tasks and expanded our guides.",
				],
			},
		],
	},
	{
		id: "august05_2026",
		date: "August 5th, 2026",
		title: "Update 2026.07: Syncing, Mobile, Editing, and more",
		body: [
			{
				t: "h3",
				c: ["Sync and sign-in"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"If your internet drops, Workflowy now reconnects more reliably so new changes sync better.",
						],
					},
					{
						t: "li",
						c: [
							"Verification code fields now support autofill on supported browsers (including mobile Safari).",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Mobile"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Fixed: Hiding the keyboard or switching apps on Android no longer does weird things to editing and searching.",
						],
					},
					{
						t: "li",
						c: [
							"iOS keyboard suggestions now work correctly when Workflowy capitalizes the first word of an item.",
						],
					},
					{
						t: "li",
						c: [
							"Long-pressing a node immediately after opening the mobile app now shows the multi-select menu.",
						],
					},
					{
						t: "li",
						c: ["The 'Add from Template' picker on mobile now closes properly."],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Editing and navigation"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"When completed items are hidden, completing several items in a row now keeps the cursor on a visible item.",
						],
					},
					{
						t: "li",
						c: [
							"Copying or cutting text from a zoomed item title now preserves its formatting instead of making it bold.",
						],
					},
					{
						t: "li",
						c: [
							"The",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/tags-dates#add-a-date-with-the-date-picker",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Date Picker and Calendar Picker"],
							},
							" ",
							"are now fully keyboard accessible.",
						],
					},
					{
						t: "li",
						c: ["Large menus and dropdowns now stay on-screen and scroll when needed."],
					},
					{
						t: "li",
						c: [
							"macOS: Using the arrow keys or pressing Enter in the emoji picker no longer moves the Workflowy caret or creates unwanted bullets.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Boards, mirrors, and files"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/exporting",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Exports"],
							},
							" ",
							"now include mirrored descendants even if they weren't expanded on screen.",
						],
					},
					{
						t: "li",
						c: [
							"Creating a card now expands its",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/boards",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["board"],
							},
							" ",
							"column, including in mirrored boards, so the new card is visible.",
						],
					},
					{
						t: "li",
						c: [
							"Undoing a",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/files-images",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["File upload"],
							},
							" ",
							"no longer leaves a missing file placeholder.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Appearance"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"New",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/settings#change-appearance",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["theme and typeface"],
							},
							": One Dark theme and Courier New typeface.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Help and documentation"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"You can now search",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Workflowy Help"],
							},
							" ",
							"docs",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/zapier",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Tidied up Zapier docs"],
							},
						],
					},
					{
						t: "li",
						c: ["Help docs are now available in Spanish, French, Japanese, and Korean."],
					},
				],
			},
		],
	},
	{
		id: "june30_2026",
		date: "June 30th, 2026",
		title: "Update 2026.06 - Tables, Workflowy Web Clipper, and more",
		body: [
			{
				t: "h3",
				c: ["Tables"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/tables.mp4",
				},
			},
			{
				t: "p",
				c: [
					"You can now turn any node into a lightweight Table, giving you a more structured way to organize plans, trackers, comparisons, and small databases.",
				],
			},
			{
				t: "p",
				c: [
					"A Table is still a list underneath. A node’s children become rows, and each row’s children become cells. Workflowy also adds a header row with blank cells so you can name your columns and give your notes more structure. You can ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/help/change-node-types",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["turn a Table back into a list"],
					},
					" at any time.",
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"You can drag and drop to reorganize rows and columns, move cells, or replace one cell with another. You can also sort, duplicate, and use",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/change-node-types",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["different node types"],
							},
							", such as To-dos, inside headers and cells, so your tables can become working plans, checklists, trackers, or drafts.",
						],
					},
					{
						t: "li",
						c: [
							"You can paste content from Excel, Google Sheets, Markdown, or TSV (tab-separated values) into a Workflowy Table and when you want to share or work with other apps, ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/exporting",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["export"],
							},
							" to HTML, Markdown, or TSV.",
						],
					},
					{
						t: "li",
						c: [
							"To try it, choose “Table” from the “Turn into” option in the node menu, or type ",
							{
								t: "code",
								c: ["/table"],
							},
							".",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Other Fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Mobile:"],
							},
							" Sync problems are now detected, shown, and recovered more reliably.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: [
									{
										t: "a",
										p: {
											href: "https://workflowy.com/help/plan-with-calendar",
											target: "_blank",
											rel: "noopener noreferrer",
											className: "contentLink !text-tint",
										},
										c: ["Calendar"],
									},
									":",
								],
							},
							" Fixed a Found Date bug that caused a calendar day node to appear inside another calendar day node.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Fixed:"],
							},
							" Tag ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/search",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["search"],
							},
							" results now expand parent nodes so matching nodes are visible.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Fixed:"],
							},
							" Damaged images and files no longer break ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/files-images",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["file uploads"],
							},
							" or previews.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Fixed:"],
							},
							" Moving nodes on mobile no longer leaves a phantom bullet stuck on the screen.",
						],
					},
					{
						t: "li",
						c: ["Added a Bold font, making your content ultra-readable."],
					},
					{
						t: "li",
						c: [
							"Link and highlight colors work in search and menus for the Vintage, Wood, and Steel themes.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Fixed:"],
							},
							" External links in the desktop app now open consistently in your web browser.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: [
									{
										t: "a",
										p: {
											href: "https://workflowy.com/help/exporting",
											target: "_blank",
											rel: "noopener noreferrer",
											className: "contentLink !text-tint",
										},
										c: ["Export"],
									},
									":",
								],
							},
							" Unicode letters are now allowed in export filenames.",
						],
					},
					{
						t: "li",
						c: ["Dropbox Backup now retries if a system error stops it, rather than silently failing."],
					},
					{
						t: "li",
						c: ["Mobile network failures during signup and login are handled more quietly and reliably."],
					},
				],
			},
		],
	},
	{
		id: "may27_2026",
		date: "May 27th, 2026",
		title: "2026.05: Timeline, Today Digest, Quick Add for iOS, and more",
		body: [
			{
				t: "h3",
				c: ["Timeline"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/timeline-update.mp4",
				},
			},
			{
				t: "p",
				c: [
					{
						t: "b",
						c: ["Timeline"],
					},
					" is now part of ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/help/plan-with-calendar",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Calendar"],
					},
					", making it easier to plan without trying to hold everything in your head.",
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["See the next 30 days at a glance and jump across the next 12 months."],
					},
					{
						t: "li",
						c: ["Drag nodes onto a date or month to schedule them."],
					},
					{
						t: "li",
						c: [
							"Use ",
							{
								t: "b",
								c: ["Move to Tomorrow"],
							},
							" and ",
							{
								t: "b",
								c: ["Next Week"],
							},
							" from the ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/slash-command",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["slash-command"],
							},
							" or item menus, or multi-select to move several items at once.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["On mobile"],
							},
							', swipe left on a node for quick access to "Move to Tomorrow" and "Next Week".',
						],
					},
					{
						t: "li",
						c: [
							"Available to all users. Requires ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/plan-with-calendar",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Calendar"],
							},
							" to be enabled.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Today Digest"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/today-digest.png",
					alt: "Today Digest",
				},
			},
			{
				t: "p",
				c: [
					"Today Digest is a morning snapshot of everything on your Workflowy calendar for today, delivered to your inbox at 8 AM, so you can start the day knowing what's on your plate without opening Workflowy.",
				],
			},
			{
				t: "p",
				c: [
					{
						t: "a",
						p: {
							href: "https://workflowy.com/today-digest/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Set up Today Digest"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Quick Add for iOS"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/ios-quick-add.png",
					alt: "Quick Add for iOS",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"A native iOS Shortcut lets you add items to Workflowy from Shortcuts or Siri without opening the app first.",
						],
					},
					{
						t: "li",
						c: [
							'Say "Hey Siri, add to Workflowy," then speak or type your note. It saves to your Inbox automatically.',
						],
					},
					{
						t: "li",
						c: [
							"If your iPhone has an Action Button, you can assign Quick Add to it for one-press capture.",
						],
					},
				],
			},
			{
				t: "p",
				c: [
					{
						t: "a",
						p: {
							href: "https://apps.apple.com/us/app/workflowy-note-list-outline/id551139514",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Get the Workflowy iOS app"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Improvements"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/files-images",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["HEIC/HEIF photo uploads"],
							},
							". iPhone photos can now be uploaded directly without converting them first.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Video plays immediately after upload"],
							},
							". Uploaded videos now display inline straight away, without requiring a page reload.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/personalize-workflowy",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Accessible fonts"],
							},
							". OpenDyslexic is now available on mobile and we've added Atkinson Hyperlegible for all platforms.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Strikethrough completed items"],
							},
							" in ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/markdown",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Markdown export"],
							},
							". Completed bullets now render with strikethrough formatting when exporting to Markdown.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://beta.workflowy.com/integrations/calendar/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Google Calendar sync"],
							},
							". When a synced event has a location, it appears as a detail node beneath the event in Workflowy.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Google Calendar sync"],
							},
							". Synced event names display in 12-hour format when no time preference has been set.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Bug Fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["iOS zoom crash on large outlines"],
							},
							". Fixed a crash when zooming into a node with a large number of children.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed a bug where using the macOS symbol/emoji picker left arrow key navigation broke until you clicked elsewhere.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed an issue where pasting formatted HTML content (e.g. from a web page) into a note removed all line breaks.",
						],
					},
					{
						t: "li",
						c: [
							"Date sort now correctly handles ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/tags-dates",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["dates"],
							},
							" preceded by a space.",
						],
					},
				],
			},
		],
	},
	{
		id: "april21_2026",
		date: "April 21st, 2026",
		title: "2026.04: Google Calendar Sync, and more",
		body: [
			{
				t: "h3",
				c: ["Google Calendar Sync"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/calendar-sync.mp4",
				},
			},
			{
				t: "p",
				c: [
					{
						t: "a",
						p: {
							href: "https://workflowy.com/integrations/calendar/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Connect your Google Calendar"],
					},
					" to Workflowy and your events will appear automatically in your Calendar node.",
				],
			},
			{
				t: "p",
				c: [
					"With your tasks, notes, and schedule all in one place, Workflowy becomes a single place to plan and organise your day. No switching between apps to figure out what's next.",
				],
			},
			{
				t: "p",
				c: ["Choose which calendars to sync and see event details and join Google Meet calls directly."],
			},
			{
				t: "p",
				c: ["Note: requires Workflowy Calendar to be enabled."],
			},
			{
				t: "p",
				c: [
					{
						t: "a",
						p: {
							href: "https://workflowy.com/integrations/calendar",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["workflowy.com/integrations/calendar"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Improvements"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/calendar#view-items-with-date-tags-in-your-calendar",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Found Dates"],
							},
							" now supports date ranges, including date ranges in the Notes field.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed a bug where dated ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/mirrors",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Mirror"],
							},
							" nodes appeared as Found Dates even when the setting was disabled.",
						],
					},
					{
						t: "li",
						c: ["Mirror To Date now works for all node types."],
					},
					{
						t: "li",
						c: ["Fixed: Unsharing a node now correctly removes the blue halo."],
					},
					{
						t: "li",
						c: [
							"Fixed an issue where users with access to a ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/share-collaborate",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["shared node"],
							},
							' incorrectly saw a "Removed by owner" message.',
						],
					},
					{
						t: "li",
						c: [
							"Sorting a ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/numbered-lists",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Numbered List"],
							},
							" now correctly places numbers before non-numeric characters.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed: The ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/todos",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["To-do"],
							},
							" node type now works in the multi-select menu.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/hotkeys",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Keyboard shortcuts"],
							},
							" are now visible in the multi-select menu.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed: The @, tag, link, and mirror buttons are now inactive on empty nodes in the mobile keyboard accessory.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed a scrolling issue with ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/boards",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["boards"],
							},
							" on mobile.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Doc Changes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"New ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["workflowy.com/help/"],
							},
							" section",
						],
					},
				],
			},
		],
	},
	{
		id: "march11_2026",
		date: "March 11th, 2026",
		title: "2026.03: Email to Workflowy, Themes for All, Improvements to Calendar, and more",
		body: [
			{
				t: "h3",
				c: ["Email to Workflowy"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/email-to-workflowy.gif",
					alt: "Email to Workflowy",
					width: "360",
				},
			},
			{
				t: "p",
				c: [
					"You can now email thoughts, notes, or links straight to Workflowy without opening the app. It's another way to get things into your Workflowy hub, so everything is there when you need it.",
				],
			},
			{
				t: "p",
				c: [
					"Get a unique email address for key nodes like Today or Inbox, or any node you've added a Shortcut to. You control which email addresses are allowed to send to it.",
				],
			},
			{
				t: "p",
				c: ["Works on shared nodes too and free for all users."],
			},
			{
				t: "p",
				c: [
					"Set it up here: ",
					{
						t: "a",
						p: {
							href: "https://beta.workflowy.com/integrations/email-to-wf/",
						},
						c: ["https://beta.workflowy.com/integrations/email-to-wf/"],
					},
				],
			},
			{
				t: "h3",
				c: ["Personalise Workflowy"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/mobile-themes.gif",
					alt: "Mobile themes",
					width: "360",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Themes are now free for everyone, everywhere (well, on desktop and mobile)."],
					},
					{
						t: "li",
						c: ["New font: Geist Mono."],
					},
				],
			},
			{
				t: "h3",
				c: ["General Fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Calendar picker now shows a marker for any Day node with content"],
					},
					{
						t: "li",
						c: ['Found Dates load correctly when mirroring "Today" to another location.'],
					},
					{
						t: "li",
						c: ["Search now matches custom formatted dates with a prefix or suffix."],
					},
					{
						t: "li",
						c: ["Pasted Google Calendar event links now open properly."],
					},
					{
						t: "li",
						c: ["mailto: links open your email client as expected."],
					},
					{
						t: "li",
						c: ["Video files no longer cause memory issues on Android and play properly."],
					},
					{
						t: "li",
						c: ["Fixed an issue that stopped the page from scrolling with the multi-select menu open."],
					},
				],
			},
		],
	},
	{
		id: "february04_2026",
		date: "February 4th, 2026",
		title: "2026.02 Quick Add for Android, Calendar/Today, Numbered Lists, Code and Quote Blocks, and more",
		body: [
			{
				t: "h3",
				c: ["Quick Add for Android"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/android-quick-capture.gif",
					alt: "Android quick add",
					width: "360",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Capture thoughts instantly with Quick Add for Android. Get ideas out of your head and into WorkFlowy, then get back to that much more important thing you were doing.",
						],
					},
					{
						t: "li",
						c: [
							"Long-press the WorkFlowy app icon to access Quick Add, or add the widget to your homescreen for faster access. Press 'Enter' to turn following lines into sub-bullets.",
						],
					},
					{
						t: "li",
						c: ["Supports text and links and Android-only for now."],
					},
				],
			},
			{
				t: "h3",
				c: ["Calendar / Today"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/move-to-today.gif",
					alt: "Moving items to Today",
					width: "360",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Drag nodes to the Calendar icon in the left sidebar to quickly move them to Today."],
					},
					{
						t: "li",
						c: ["The Calendar Picker now includes Found Dates so you can see what's coming up."],
					},
					{
						t: "li",
						c: ["Found Dates now supports Date ranges, with nodes appearing for each day."],
					},
					{
						t: "li",
						c: ["Found Dates now show in mirrors of the 'Today' node."],
					},
				],
			},
			{
				t: "h3",
				c: ["Numbered Lists"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/numbering-mirrors.gif",
					alt: "Numbered mirrors update",
					width: "360",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Turning a numbered node into another type now updates properly in Mirror copies."],
					},
					{
						t: "li",
						c: ["Fixed wrapping issues with 4-digit and longer numbered lists."],
					},
					{
						t: "li",
						c: [
							"Numbers at the start of bullets from before the Numbered List item type are now preserved when converting to Numbered Lists.",
						],
					},
				],
			},
			{
				t: "h3",
				c: ["Quote and Code Blocks"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/code-block-formatting.gif",
					alt: "Code block formatting update",
					width: "360",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Converting Code Blocks & Quotes back to another item type now properly separates line breaks into individual nodes.",
						],
					},
					{
						t: "li",
						c: [
							"Converting multiple nodes into a Code Block or Quote now combines them into one block with line breaks.",
						],
					},
					{
						t: "li",
						c: ["Code Blocks display # and @ tags properly"],
					},
				],
			},
			{
				t: "h3",
				c: ["General Fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ['iOS: Searches using quotes ("") now work with Smart Punctuation turned on.'],
					},
					{
						t: "li",
						c: ["iOS: The Copy button in the Export screen now works reliably."],
					},
					{
						t: "li",
						c: [
							"Fixed a bug where applying colors to hashtags with double quotes would make that color unavailable for text highlighting elsewhere.",
						],
					},
					{
						t: "li",
						c: ["Fixed text wrapping on Todo nodes with long text."],
					},
					{
						t: "li",
						c: ["Fixed scrolling in the Add from Template search menu."],
					},
					{
						t: "li",
						c: ["Mirrors are now highlighted when using a nested search."],
					},
					{
						t: "li",
						c: ["Improved case sensitivity handling for languages like Turkish"],
					},
					{
						t: "li",
						c: ["Fixed unexpected behavior when copying colored text"],
					},
				],
			},
			{
				t: "h3",
				c: ["Doc Changes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Added ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/help/get-started",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Using Workflowy page"],
							},
						],
					},
				],
			},
		],
	},
	{
		id: "january22_2026",
		date: "January 22nd, 2026",
		title: "2026.01 Patch Notes: Cross-tab drag and drop, improvements to numbered lists, dates, and more",
		body: [
			{
				t: "h3",
				c: ["Drag and drop across tabs"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/drag-and-drop-across-tabs.gif",
					alt: "Drag and drop across tabs",
				},
			},
			{
				t: "p",
				c: [
					"You can now drag nodes between Workflowy tabs in Chrome, Edge, Firefox, Dia on PC/Mac and Safari on Mac. It works with Chrome's split screen view too.",
				],
			},
			{
				t: "p",
				c: [
					"This makes it easier to move nodes between different parts of your outline without scrolling back and forth.",
					" ",
				],
			},
			{
				t: "p",
				c: [
					{
						t: "b",
						c: ["Note:"],
					},
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Both tabs need to be signed into the same account."],
					},
					{
						t: "li",
						c: ["You can't drag between different apps (like from the desktop app to your browser)."],
					},
					{
						t: "li",
						c: ["Dragged items might take a second to appear in some browsers."],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Numbered Lists"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/auto-numbering.gif",
					alt: "Auto numbering lists",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Toggle numbered lists on/off in the Settings."],
					},
					{
						t: "li",
						c: [
							"Type ",
							{
								t: "code",
								c: ["[number]."],
							},
							" followed by a space to create a numbered list",
						],
					},
					{
						t: "li",
						c: [
							"Start at any number (e.g., type ",
							{
								t: "code",
								c: ["256. [text]"],
							},
							" to begin at 256)",
						],
					},
					{
						t: "li",
						c: [
							"Pasted markdown numbered lists (e.g., ",
							{
								t: "code",
								c: ["1. [text]"],
							},
							") are automatically formatted",
						],
					},
					{
						t: "li",
						c: ["Numbers are preserved in search results, zoom view, imported and exported text."],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Dates"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/day-of-the-week-search-operator.gif",
					alt: "Day of the week search operator",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Search Date tags by the day of the week. For example, searching for",
							" ",
							{
								t: "code",
								c: ["day-of-week: Monday"],
							},
							" will match any Date tag that is a Monday.",
						],
					},
					{
						t: "li",
						c: ["Use your custom date format in global search"],
					},
					{
						t: "li",
						c: ["Fixed: Date Picker bug that changed the year to next year when selecting any past date."],
					},
					{
						t: "li",
						c: [
							"Fixed: Typing 'morning', 'afternoon, 'evening', 'noon', or 'night' no longer auto-converts to dates",
						],
					},
					{
						t: "li",
						c: [
							"Fixed: ",
							{
								t: "code",
								c: ["tomorrow"],
							},
							" typed between midnight and 1am now correctly tags the next day",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["General"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/code-block-copy.gif",
					alt: "Code block copy",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Tidy up your",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/calendar/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Calendar"],
							},
							" ",
							"without having to change the layout settings",
						],
					},
					{
						t: "li",
						c: [
							"Faster",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/slash-command/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["alphabetical sorting"],
							},
							" ",
							"for large lists",
						],
					},
					{
						t: "li",
						c: ["Copy to Clipboard button added to code blocks"],
					},
					{
						t: "li",
						c: ["New setting: auto-capitalize first letter of new bullets"],
					},
					{
						t: "li",
						c: [
							"New font:",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/settings/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Junicode"],
							},
						],
					},
					{
						t: "li",
						c: [
							"Fixed: Download videos in the",
							" ",
							{
								t: "a",
								p: {
									href: "https://play.google.com/store/apps/details?id=com.workflowy.android",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Android app"],
							},
						],
					},
					{
						t: "li",
						c: [
							"Fixed: White flash when opening the",
							" ",
							{
								t: "a",
								p: {
									href: "https://apps.apple.com/us/app/workflowy-note-list-outline/id551139514",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["iOS app"],
							},
							" ",
							"in dark mode",
						],
					},
					{
						t: "li",
						c: ["Fixed: YouTube Shorts playback"],
					},
				],
			},
		],
	},
	{
		id: "december03_2025",
		date: "December 3rd, 2025",
		title: "2025.21 Numbered Lists, Chocolate and Matcha Themes, Calendar Polishing, Nips and Tucks",
		body: [
			{
				t: "h3",
				c: ["Numbered List"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/numbered-lists.mp4",
				},
			},
			{
				t: "p",
				c: [
					"Long requested by the very organised Workflowy user, you can now easily turn any item into a ",
					{
						t: "strong",
						c: ["Numbered"],
					},
					" list! Great for er, putting things in order.",
				],
			},
			{
				t: "p",
				c: [
					"Find it in the Item menu, Slash Command (",
					{
						t: "code",
						c: ["/number"],
					},
					"), or by pressing ",
					{
						t: "code",
						c: ["Ctrl"],
					},
					" + ",
					{
						t: "code",
						c: ["Alt"],
					},
					" + ",
					{
						t: "code",
						c: ["0"],
					},
					" on PC (",
					{
						t: "code",
						c: ["Cmd"],
					},
					" + ",
					{
						t: "code",
						c: ["Opt"],
					},
					" + ",
					{
						t: "code",
						c: ["0"],
					},
					" on Mac).",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Themes"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/chocolate-matcha.png",
					alt: "Chocolate and Matcha Themes",
				},
			},
			{
				t: "p",
				c: ["We've added two new themes to bring some seasonal warmth; Matcha and Chocolate."],
			},
			{
				t: "p",
				c: [
					"Available to all Workflowy users in the",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/settings/#change-appearance",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Settings"],
					},
					" ",
					"> Theme dropdown.",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Calendar"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/found-dates-toggle.png",
					alt: "Found Dates Toggle",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"We've polished the",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/calendar/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Calendar"],
							},
							" ",
							"again to smooth off some rough little edges:",
						],
					},
					{
						t: "li",
						c: [
							"The Calendar Picker now clearly shows",
							" ",
							{
								t: "strong",
								c: ["dates that contain nodes"],
							},
							", making it easier to see which days are already busy.",
						],
					},
					{
						t: "li",
						c: [
							"You can ",
							{
								t: "strong",
								c: ["toggle Found Dates"],
							},
							" from being displayed in the Calendar.",
						],
					},
					{
						t: "li",
						c: [
							"Toggling ",
							{
								t: "strong",
								c: ["Friendly Date Names"],
							},
							" no longer triggers a full Calendar reorganisation.",
						],
					},
					{
						t: "li",
						c: [
							"We'll now show a warning before updating your Calendar if you have changed Calendar ",
							{
								t: "strong",
								c: ["Year, Month, or Week"],
							},
							" with a new name or note. This prevents you from accidentally wiping out your carefully crafted content.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed an issue that caused ",
							{
								t: "strong",
								c: ["duplicate calendar dates"],
							},
							" ",
							"when migrating a node with both a date and time tag.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Boards UI Improvements"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/board-ui-improvements.png",
					alt: "Boards UI Improvements",
				},
			},
			{
				t: "p",
				c: [
					"We polished the look and feel of",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/boards/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Boards"],
					},
					". This includes fixing the ",
					{
						t: "strong",
						c: ["sub-column padding"],
					},
					" issue that made the text inside cards look vertically off-center, making sure",
					" ",
					{
						t: "strong",
						c: ["numbered lists"],
					},
					" display properly, and correcting",
					" ",
					{
						t: "strong",
						c: ["arrow positioning on mobile"],
					},
					".",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["API Support"],
			},
			{
				t: "p",
				c: [
					"External tools can now better integrate, as we've added support for parsing markdown dates and",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/api-reference/#formatting",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["content formatting"],
					},
					".",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["General Quality of Life"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "strong",
								c: ["Inline searches"],
							},
							" (like in ",
							{
								t: "code",
								c: ["/Move to"],
							},
							") now use natural dates again.",
						],
					},
					{
						t: "li",
						c: [
							"The ",
							{
								t: "strong",
								c: ['"Home" bullet'],
							},
							" now appears in inline search results, making it faster to drop items back at the top.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed ",
							{
								t: "strong",
								c: ["mobile auto-scrolling"],
							},
							" on new lines—text will no longer jump too high and disappear above the keyboard when you press Enter.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed that annoying ",
							{
								t: "strong",
								c: ["iPad"],
							},
							" bug where you had to double-tap on UI controls to expand, collapse, and zoom.",
						],
					},
					{
						t: "li",
						c: [
							"Fixed the ",
							{
								t: "strong",
								c: ["153 error"],
							},
							" when playing embedded YouTube videos.",
						],
					},
				],
			},
		],
	},
	{
		id: "november19_2025",
		date: "November 19th, 2025",
		title: "2025.20 Calendar Found Dates, New Themes, Mirror Improvements, and More",
		body: [
			{
				t: "h3",
				c: ["Calendar Found Dates"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/found-dates.png",
					alt: "Found Dates",
				},
			},
			{
				t: "p",
				c: [
					"Your",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/calendar/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Calendar"],
					},
					" ",
					"now shows matching ",
					{
						t: "b",
						c: ["Found Dates"],
					},
					" from anywhere in your account, making it even better for daily planning and note-taking.",
				],
			},
			{
				t: "p",
				c: ["Drag any Found Date to your Calendar day to move it there."],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Personalization"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/robot-glass-themes.png",
					alt: "Robot and Glass Themes",
				},
			},
			{
				t: "p",
				c: [
					"Two fresh new",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/settings/#change-appearance",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["themes"],
					},
					" ",
					"to help you make Workflowy your own: Robot and Glass.",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Mirrors"],
			},
			{
				t: "p",
				c: [
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/mirrors/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Mirrors"],
					},
					" ",
					"just got a little bit more reliable and useful:",
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Mirror nodes now appear in search results even when 'Show completed' is turned off, making it easier to find all of your content.",
						],
					},
					{
						t: "li",
						c: ["Moving Mirrors in the search results no longer causes them to disappear."],
					},
					{
						t: "li",
						c: ["Mirrors stay selected after moving a group of them, so you can keep working."],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Search and Organize"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Friendly date search"],
							},
							".",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/search/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Searching"],
							},
							" ",
							"for natural language dates like 'Today' or 'Last week' in JumpTo, MoveTo, MirrorTo, and LinkTo menus now matches their corresponding dated nodes.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Improved multi-select dragging on mobile"],
							},
							". Drag and drop for multi-selected nodes is now more reliable and you can drag bullets from different indent levels under a single node, and they'll flatten correctly as expected.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Board"],
							},
							" columns no longer glitch when a collaborator is editing a shared board at the same time.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Better nested search"],
							},
							". Nested search now supports multiple words. For example, searching ",
							{
								t: "code",
								c: ["Projects"],
							},
							" >",
							" ",
							{
								t: "code",
								c: ["Write draft -today"],
							},
							" will match nodes containing both 'Write draft' and '-today'.",
						],
					},
				],
			},
		],
	},
	{
		id: "november04_2025",
		date: "November 4th, 2025",
		title: "2025.19 Faster Mobile, Smarter Calendar, API Update",
		body: [
			{
				t: "h3",
				c: ["Calendar / Today"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/friendly-day-names-in-sidebar.png",
					alt: "Friendly Day Names in Sidebar",
				},
			},
			{
				t: "p",
				c: [
					"We've made several improvements to",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/learn/calendar/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["Calendar / Today"],
					},
					". If you haven't tried it yet, it's a way to organize your tasks, notes, and journal. Here's what we've fixed and improved:",
				],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ['Sidebar now shows friendly day names ("Today, Tomorrow, Yesterday").'],
					},
					{
						t: "li",
						c: ["Old calendar entries now merge properly when migrating to new calendar nodes."],
					},
					{
						t: "li",
						c: ["Fixed cross-device sync issue that created duplicate calendars when tapping 'Today'."],
					},
					{
						t: "li",
						c: ["Prevented duplicate calendar items with the same date."],
					},
					{
						t: "li",
						c: ["Fixed duplicate date entries when switching time zones."],
					},
					{
						t: "li",
						c: [
							"Fixed overlapping text bug when deleting a zoomed in date tag for Today, Tomorrow, and Yesterday.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Mobile Improvements"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Board columns now have a minimum width on mobile."],
					},
					{
						t: "li",
						c: ["iOS keyboard no longer covers the node you're editing."],
					},
					{
						t: "li",
						c: ["Fixed annoying micro-bounce when typing on iOS."],
					},
					{
						t: "li",
						c: ["Nodes now stay in the right order when after using multi-select move or drag and drop."],
					},
					{
						t: "li",
						c: ["Fixed swipe menu bug after canceling multi-select."],
					},
					{
						t: "li",
						c: ["Selecting nodes in search mode won't auto-outdent them anymore (iOS)"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["New API Endpoints"],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/api-targets.png",
					alt: "API Targets",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/api-reference/#targets",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Targets"],
							},
							" ",
							"provide quick access to specific nodes for your API calls, including both system targets (like 'Inbox') and custom",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/shortcuts/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Shortcuts"],
							},
							" ",
							"you create (like 'in' for 'Inbox').",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/api-reference/#nodes-move",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Move a node"],
							},
							" ",
							"will... move a node to a specific target. This can be a node ID or a Target (see above).",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://workflowy.com/api-reference/#nodes-export",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Export all nodes"],
							},
							" ",
							"will return all content as a flat list.",
						],
					},
					{
						t: "li",
						c: [
							"View the",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/api-reference/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["API docs"],
							},
							" ",
							"for more details.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Other Fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Indenting/outdenting mirrors works smoothly now."],
					},
					{
						t: "li",
						c: ["AI Chat ignores mirrors (no more infinite loops)."],
					},
				],
			},
		],
	},
	{
		id: "october23_2025",
		date: "October 23rd, 2025",
		title: "2025.18 /Move to Date, Import Kindle Highlights, Fonts, Moon Theme, Calendar TLC, and More",
		body: [
			{
				t: "h3",
				c: ["/Move to Date"],
			},
			{
				t: "p",
				c: [
					"Type ",
					{
						t: "code",
						c: ["/Move to Date"],
					},
					" (or ",
					{
						t: "code",
						c: ["/Date"],
					},
					") when you need to plan, reshuffle, or punt things into the future (or drag them back from it). It’s also in the multi-select menu, because let’s be honest, it’s never just one thing.",
				],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/move-to-date-optimized.mp4",
				},
			},
			{
				t: "h3",
				c: ["Import Kindle Highlights and Notes"],
			},
			{
				t: "p",
				c: [
					{
						t: "b",
						c: ["Import your Kindle Highlights and Notes"],
					},
					" directly into Workflowy to keep them safe and organized. No more worrying about your My Clippings.txt mysteriously disappearing (I'm looking at you, Paperwhite).",
				],
			},
			{
				t: "p",
				c: [
					"Get started here:",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/integrations/kindle/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["https://workflowy.com/integrations/kindle/"],
					},
				],
			},
			{
				t: "h3",
				c: ["Personalization"],
			},
			{
				t: "p",
				c: [
					"Six new fonts to make Workflowy feel more like home: ET Book, IBM Plex Mono, Inter, JetBrains Mono, Lexend, and Open Sans.",
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/new-fonts.png",
					alt: "New Fonts",
				},
			},
			{
				t: "p",
				c: [
					{
						t: "b",
						c: ["New Moon theme:"],
					},
					" Soft, warm colors that are gentle on your eyes during those long work sessions. Hmmm. Smooth!",
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/moon-theme.png",
					alt: "Moon Theme",
				},
			},
			{
				t: "p",
				c: ["Free for all users, available in the Settings."],
			},
			{
				t: "h3",
				c: ["Calendar"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"When you disable date groupings (Weeks, Months, Years) in the Calendar Layout menu, any nodes without calendar dates will automatically move to their nearest parent node.",
						],
					},
					{
						t: "li",
						c: ['Disabling "Friendly" date names in the Calendar Layout menu now works as expected.'],
					},
					{
						t: "li",
						c: [
							"Calendar layout changes now include a confirmation prompt before moving undated nodes, giving you a heads-up before any changes are made.",
						],
					},
					{
						t: "li",
						c: [
							"When moving a dated node with dated children, only the parent moves to its new date location. The children stay attached to the parent so they won't scatter to their own dates.",
						],
					},
				],
			},
			{
				t: "h3",
				c: ["Quality-of-life Improvements"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							'The "Home" button in the sidebar now navigates to your home page instead of expanding/collapsing the section.',
						],
					},
					{
						t: "li",
						c: ["Redesigned Export pane with a cleaner button layout and improved mobile experience."],
					},
					{
						t: "li",
						c: [
							"Pasting a URL over an existing URL link now updates both the link destination and display text.",
						],
					},
					{
						t: "li",
						c: ["Fixed GPU performance issues on macOS Tahoe in the desktop app."],
					},
					{
						t: "li",
						c: ["Improved keyboard shortcut support for external keyboards on iOS."],
					},
					{
						t: "li",
						c: ["Indentation now displays correctly when selecting nodes in mobile search mode."],
					},
				],
			},
		],
	},
	{
		id: "october07_2025",
		date: "October 7th, 2025",
		title: "2025.17 Update",
		body: [
			{
				t: "h3",
				c: ["The Calendar/ Today Feature"],
			},
			{
				t: "p",
				c: [
					"The Time Bureau, the Ministry of Time, the Time Police, the Temporal Enforcement Division, the Time Agency, and Time Patrol have all unanimously given WorkFlowy the green lights to build our very own time machine.",
				],
			},
			{
				t: "p",
				c: [
					"Whether you’re into journaling, if you keep a tickler file in WorkFlowy… or simply prefer to create, categorize and reference notes according to date, we now have a dedicated space where you can create new dates on demand, and offload your thoughts, plans, reminders — and everything else you’d like to throw at WorkFlowy.",
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/calendar.gif",
					alt: "Calendar",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"On desktop, press ",
							{
								t: "code",
								c: ["Today"],
							},
							" in the header or sidebar, or use",
							" ",
							{
								t: "code",
								c: ["Alt+T"],
							},
							"(Windows)/ ",
							{
								t: "code",
								c: ["Ctrl+T (Mac)"],
							},
							". On mobile, tap",
							" ",
							{
								t: "code",
								c: ["Today"],
							},
							" in the navigation bar. This creates a Calendar hierarchy of Year → Month → Day nodes.",
						],
					},
					{
						t: "li",
						c: [
							"Use the Next, Previous, and Calendar Picker buttons to jump between dates. New nodes are created automatically as needed.",
						],
					},
					{
						t: "li",
						c: [
							"To customize the Calendar node, open the Calendar Picker, select",
							" ",
							{
								t: "code",
								c: ["Calendar Layout"],
							},
							", and choose any combination of Year, Month or Week for your desired hierarchy. You can also select",
							" ",
							{
								t: "code",
								c: ["Friendly day names"],
							},
							" to visually clue you in when you’re looking at yesterday, today or tomorrow’s nodes.",
						],
					},
					{
						t: "li",
						c: [
							"You can move your own-rolled calendar, journal or any nodes with Date tags into the new Calendar. To do this, drag any node with a Date tag (type ",
							{
								t: "code",
								c: ["!!"],
							},
							" to add one) under the Calendar node. Then, open",
							" ",
							{
								t: "code",
								c: ["Calendar Layout"],
							},
							" from the Calendar Picker, and press",
							" ",
							{
								t: "code",
								c: ["Update"],
							},
							" to reorganize.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "p",
				c: [
					{
						t: "b",
						c: ["Calendar migration"],
					},
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/its-a-new-day.gif",
					alt: "Calendar migration",
				},
			},
			{
				t: "p",
				c: [
					"Finally, you can move any node to the current day with the",
					" ",
					{
						t: "code",
						c: ["/Move to Today"],
					},
					" and ",
					{
						t: "code",
						c: ["Mirror to Today"],
					},
					" commands (or their multi‑select menu options).",
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Lots of mobile TLC"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Multi-Select is now available to everyone (previously Labs only)"],
					},
					{
						t: "li",
						c: [
							"We’ve added ",
							{
								t: "code",
								c: ["Export"],
							},
							" to the mobile multi-select bar",
						],
					},
					{
						t: "li",
						c: ["Long pressing a selected node now initiates drag‑and‑drop for one or more nodes"],
					},
					{
						t: "li",
						c: ["Templates, date nodes and images are now easier to select"],
					},
					{
						t: "li",
						c: ["We’ve fixed finicky page scrolling when items are dropped into a collapsed bullet"],
					},
					{
						t: "li",
						c: [
							"Mobile multi-select now closes after using the ",
							{
								t: "code",
								c: ["/MoveTo"],
							},
							" ",
							"command",
						],
					},
					{
						t: "li",
						c: ["We’ve fixed the drag handle in todos with long names"],
					},
					{
						t: "li",
						c: ["Multi-select item type menu now works properly"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["More quality-of-life items"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Workflowy now imports tags from Readwise"],
					},
					{
						t: "li",
						c: ["The create a node API endpoint now graciously accepts markdown"],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Fringe fixes (if you know, you know)"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"The last column of a board no longer disappears when the span of all columns is a tad wider than the screen.",
						],
					},
					{
						t: "li",
						c: [
							"You can now find 2025 in a jump-to search, even if your date format in Settings doesn’t display the current year.",
						],
					},
					{
						t: "li",
						c: [
							"You can now ",
							{
								t: "code",
								c: ["Ctrl/Cmd+Click"],
							},
							" on dates with a custom format and find all related dates.",
						],
					},
				],
			},
		],
	},
	{
		id: "september24_2025",
		date: "September 24th, 2025",
		title: "2025.16 Update",
		body: [
			{
				t: "h3",
				c: ["New Features"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Catppuccin Theme"],
					},
				],
			},
			{
				t: "p",
				c: [
					"We’ve added the Catppuccin theme to Workflowy! You don't have to think of cats as being particularly cozy or even appreciate a cappuccino buzz... but there's something about this pastel-on-dark backdrop that feels comfortable and easy on the eyes from the get-go.",
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/catppuccin-theme.png",
					alt: "Catppuccin Theme",
				},
			},
			{
				t: "br",
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "a",
								p: {
									href: "https://addons.mozilla.org/en-US/firefox/addon/workflowy-clipper-official/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["Firefox Clipper"],
							},
						],
					},
				],
			},
			{
				t: "p",
				c: [
					"... and then there were two. For the longest of times we've had the Chrome Clipper. This may not be as story worthy as Apollo and Artemis, but for sure, it represents a quality-of-life addition for our Firefox users.",
				],
			},
			{
				t: "p",
				c: [
					"The default shortcut is ",
					{
						t: "code",
						c: ["Ctrl+Shift+Y"],
					},
					" (",
					{
						t: "code",
						c: ["Cmd+Shift+Y"],
					},
					" on Mac) – which will be different if some other extension has already called dibs on it.",
				],
			},
			{
				t: "p",
				c: ["Please make sure to use the official link — there are clipper addons made by other folk."],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Quality-of-life improvements"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"New slash command: ",
							{
								t: "code",
								c: ["/Delete File"],
							},
							" to remove an attachment from a node. So quick... so much closure!",
						],
					},
					{
						t: "li",
						c: ["Readwise Integration:"],
					},
					{
						t: "ul",
						c: [
							{
								t: "li",
								c: ["Improved the syncing of large numbers of highlights"],
							},
							{
								t: "li",
								c: [
									"Improved sorting: new sources appear on top and the highlights are sorted alphabetically based on creation date",
								],
							},
							{
								t: "li",
								c: ["We now add a link if the source has a URL"],
							},
							{
								t: "li",
								c: ["The integration page now has a link to the Readwise node in WorkFlowy"],
							},
						],
					},
					{
						t: "li",
						c: [
							"For developers: The",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/api-reference/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["API Reference"],
							},
							" ",
							"is mobile friendly now.",
						],
					},
				],
			},
			{
				t: "br",
			},
			{
				t: "h3",
				c: ["Bug fixes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Sharing to Workflowy on iOS 26 should work again!"],
					},
					{
						t: "li",
						c: ["Clicking on your own @mention now shows your mentions."],
					},
					{
						t: "li",
						c: [
							'The " Duplicate with #copy " toggle in Settings is now respected when duplicating when ',
							{
								t: "code",
								c: ["Alt + Drag"],
							},
						],
					},
					{
						t: "li",
						c: [
							"(Desktop web + app) Multiselect with keyboard no longer extends beyond your current zoom level on desktop.",
						],
					},
					{
						t: "li",
						c: [
							"(Desktop web) Fixed loading issues when zooming into items – there should be no redirect to your Home page when refreshing the page on a newly created item (or opening a link to a newly created item).",
						],
					},
				],
			},
		],
	},
	{
		id: "september18_2025",
		date: "September 18th, 2025",
		title: "Patch Notes",
		body: [
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Press ",
							{
								t: "code",
								c: ["Ctrl"],
							},
							" (",
							{
								t: "code",
								c: ["Option"],
							},
							" on Mac) and click a date tag to search for that date in the current node and descendants.",
						],
					},
					{
						t: "li",
						c: ['New "/Mirror To Child" command, by analogy with "/Move To Child"'],
					},
					{
						t: "li",
						c: ["Searching for your own mention now shows correct results in private spaces as well"],
					},
					{
						t: "li",
						c: ["Duplicating expanded nodes no longer leaves the duplicate in a weird half-expanded state"],
					},
					{
						t: "li",
						c: [
							"Pasting ",
							{
								t: "code",
								c: ["[t]"],
							},
							" and similar is no longer treated as a markdown todo, the pattern is narrowed down to ",
							{
								t: "code",
								c: ["[ xX-]"],
							},
						],
					},
					{
						t: "li",
						c: [
							"Improved cursor positioning on Android, so it doesn't get hidden behind the header when the keyboard is opened (let us know if it still does for you)",
						],
					},
					{
						t: "li",
						c: [
							"Sharing a .txt file to Workflowy on Android is now recognized as text share and the file contents are automatically added to the text area",
						],
					},
					{
						t: "li",
						c: [
							"Using numbers as",
							" ",
							{
								t: "a",
								p: {
									href: "https://workflowy.com/learn/shortcuts/",
									target: "_blank",
									rel: "noopener noreferrer",
									className: "contentLink !text-tint",
								},
								c: ["shortcuts"],
							},
							" ",
							"no longer provokes sync errors in some situations",
							" ",
						],
					},
					{
						t: "li",
						c: [
							'Typing e.g. "5.10.2025" is now recognized correctly with a custom date format like "DD.MM.YYYY"',
						],
					},
					{
						t: "li",
						c: ["Fixed Japanese character selector highlighting when using keyboard on iPad Workflowy"],
					},
				],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/move-to-child.mp4",
				},
			},
		],
	},
	{
		id: "september17_2025",
		date: "September 17th, 2025",
		title: "Mobile Multi-Select",
		body: [
			{
				t: "p",
				c: [
					"Long-requested, you can now ",
					{
						t: "b",
						c: ["select multiple nodes on Mobile"],
					},
					". Long-press a node, select several, then use the drag-handle to move them. Use the bottom toolbar to change item type (todos, bullets, quotes, etc.), duplicate, move or mirror.",
				],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/mobile-multi-select.mp4",
				},
			},
		],
	},
	{
		id: "september15_2025",
		date: "September 15th, 2025",
		title: "AI Quick Actions",
		body: [
			{
				t: "p",
				c: [
					"Pro subscribers with AI enabled can use AI Quick Actions . Edit and create content right in your notes. You can summarize, create outlines, extract tasks, fix grammar, and shorten text. Type ",
					{
						t: "code",
						c: ["/ai"],
					},
					" to use them.",
				],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/ai-quick-actions.mp4",
				},
			},
		],
	},
	{
		id: "september10_2025",
		date: "September 10th, 2025",
		title: "Readwise",
		body: [
			{
				t: "p",
				c: [
					"You can now sync your reading highlights from Readwise directly into Workflowy. Connect your Readwise account and import all your book highlights, article clips, tweets, and podcast notes as a structured hierarchy.",
				],
			},
			{
				t: "p",
				c: [
					"Get started at",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/integrations/readwise/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["https://workflowy.com/integrations/readwise/"],
					},
				],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/readwise.mp4",
				},
			},
		],
	},
	{
		id: "september04_2025",
		date: "September 4th, 2025",
		title: "AI Nodes",
		body: [
			{
				t: "p",
				c: [
					"Pro subscribers with AI enabled can now use AI Nodes – a new node type that generates content to help you plan, summarize, draft, and create inside Workflowy. Try it with /ai or from the Turn into… menu.",
				],
			},
			{
				t: "p",
				c: ["Exploring ideas"],
			},
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/ai-nodes-1.mp4",
				},
			},
		],
	},
	{
		id: "september03_2025",
		date: "September 3rd, 2025",
		title: "Patch Notes",
		body: [
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/in-note-search-operator.mp4",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Mirroring no longer leaves the ",
							{
								t: "code",
								c: ["((...))"],
							},
							" when the mirror is created as a sibling of the item you're typing in",
						],
					},
					{
						t: "li",
						c: [
							'The "Start of week" setting is now supporter better in search. Let us know if you still encounter situations where it\'s not respected',
						],
					},
					{
						t: "li",
						c: ["The Jump To dialog no longer suggests in the search results parts of AI conversations"],
					},
					{
						t: "li",
						c: [
							"You can now limit search to the notes field only. Type",
							" ",
							{
								t: "code",
								c: ['in:note:"Hello"'],
							},
							" in the search box to do this. The same goes for backlinks - try ",
							{
								t: "code",
								c: ['in:backlink:"Again"'],
							},
							" ",
						],
					},
					{
						t: "li",
						c: ["PDF viewer no longer shows blank space in place of some background images"],
					},
					{
						t: "li",
						c: ["Uploaded pictures no longer unexpectedly rotate 90 degree"],
					},
					{
						t: "li",
						c: ["Checkboxes are now better aligned when you adjust font size on mobile"],
					},
					{
						t: "li",
						c: ["Font size in the date autocomplete on mobile is decreased to fit longer formats"],
					},
					{
						t: "li",
						c: [
							"The custom date format is now respected when you link to a node (e.g. with ",
							{
								t: "code",
								c: ["[[...]]"],
							},
							")",
						],
					},
					{
						t: "li",
						c: [
							"Use new ",
							{
								t: "code",
								c: ["/count"],
							},
							" to see the amount of items and words inside the tree",
						],
					},
					{
						t: "li",
						c: [
							"Use new ",
							{
								t: "code",
								c: ["/Priority: Default to..."],
							},
							" to define whether children should go to the bottom or to the top when you send them to this node via ",
							{
								t: "code",
								c: ["/Move To"],
							},
							" or ",
							{
								t: "code",
								c: ["/Mirror To"],
							},
							" ",
						],
					},
					{
						t: "li",
						c: ["Slash command executed at the end of a node automatically removes the redundant space"],
					},
				],
			},
		],
	},
	{
		id: "september02_2025",
		date: "September 2nd, 2025",
		title: "Rudimentary API",
		body: [
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/rudimentary-api.jpg",
					alt: "Rudimentary API",
				},
			},
			{
				t: "p",
				c: [
					"We're not excited at all to announce a very basic, barely useful API! You can find the full reference here:",
					" ",
					{
						t: "a",
						p: {
							href: "https://workflowy.com/api-reference/",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["https://workflowy.com/api-reference/"],
					},
					".",
				],
			},
			{
				t: "p",
				c: [
					"We're making it this small on purpose: we have no idea what you actually want to build with an API, and developing it any further without your input would just be guesswork.",
				],
			},
			{
				t: "p",
				c: [
					"So if you want Workflowy to have a decent API, go try to build whatever you wanted to build with this barebones version and then tell us exactly where it fails you!",
				],
			},
		],
	},
	{
		id: "august29_2025",
		date: "August 29th, 2025",
		title: "2025.12 - .deb package now available for Linux",
		body: [
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/deb-file.jpg",
					alt: ".deb file for Linux",
				},
			},
			{
				t: "p",
				c: [
					"We've added .deb packages for Ubuntu users. Our AppImage won't work starting with Ubuntu 24.04, so you should switch if you're on Ubuntu. Download the .deb package from",
					" ",
					{
						t: "a",
						p: {
							href: "https://github.com/workflowy/desktop/releases/latest",
							target: "_blank",
							rel: "noopener noreferrer",
							className: "contentLink !text-tint",
						},
						c: ["https://github.com/workflowy/desktop/releases/latest"],
					},
					".",
				],
			},
			{
				t: "p",
				c: [
					"If you've already noticed and installed the .deb package before this announcement, please download it again from the link above and re-install for auto-updates to work properly.",
				],
			},
		],
	},
	{
		id: "august28_2025",
		date: "August 28th, 2025",
		title: "2025.11 - PDF Reader",
		body: [
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/pdf-reader.mp4",
				},
			},
			{
				t: "p",
				c: [
					"It is now possible to view uploaded PDF files without leaving the app, both in the desktop and the mobile apps.",
				],
			},
			{
				t: "p",
				c: [
					"The viewer has the basic scrolling, jump to page, and zooming functionality. Let us know what else you would like to see.",
				],
			},
		],
	},
	{
		id: "august19_2025",
		date: "August 19th, 2025",
		title: "August 19, 2025. Patch Notes.",
		body: [
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/markdown-todos.mp4",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Custom font selected in Settings is applied to the sidebar again"],
					},
					{
						t: "li",
						c: [
							"The todo hotkey (",
							{
								t: "code",
								c: ["Alt+Ctrl+9"],
							},
							" or ",
							{
								t: "code",
								c: ["Opt+Cmd+9"],
							},
							") is now applied to all selected items, not just the first one",
						],
					},
					{
						t: "li",
						c: [
							"Typing ",
							{
								t: "code",
								c: ["[]"],
							},
							" or ",
							{
								t: "code",
								c: ["[ ]"],
							},
							" at the beginning of the line and then pressing space now turns the node into a todo",
						],
					},
					{
						t: "li",
						c: [
							"Uploading images no longer fails in some peculiar situations when the app is unable to obtain your image's exif data",
						],
					},
					{
						t: "li",
						c: [
							"Spaces are now preserved for the nodes shown in the left bar exactly the way you typed them in the main tree",
						],
					},
					{
						t: "li",
						c: [
							'Exporting in the Markdown format no longer adds a redundant dot before the file extension (e.g. "file..md")',
						],
					},
					{
						t: "li",
						c: [
							"The status bar on Android 15+ now matches the theme color and keeps status indicators clearly visible",
						],
					},
					{
						t: "li",
						c: ["You can now choose in settings whether to add the #copy tag to the duplicated nodes"],
					},
					{
						t: "li",
						c: [
							"Drag-n-drop of nodes in the Starred section of the sidebar now actually works on Android, not just pretends to.",
						],
					},
				],
			},
		],
	},
	{
		id: "august13_2025",
		date: "August 13th, 2025",
		title: "August 13, 2025. Patch Notes.",
		body: [
			{
				t: "video",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/disable-quick-add.mp4",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							'The status bar text color now properly switches to white when iOS is in dark mode and Workflowy\'s theme is set to "System".',
						],
					},
					{
						t: "li",
						c: [
							"The ",
							{
								t: "code",
								c: ["dd D.M.Y"],
							},
							" format is correctly recognized when entering a date (let us know if you have trouble entering dates with other formats)",
						],
					},
					{
						t: "li",
						c: ["The ability to paste internal links over selected text is restored."],
					},
					{
						t: "li",
						c: [
							'"file.md" is no longer auto-linked unless it has a protocol. You\'ll need to manually unlink existing "file.md" links.',
						],
					},
					{
						t: "li",
						c: [
							"Numbered reference lines like [1] see source are now preserved when pasted — WorkFlowy no longer treats them as completed Markdown todos.",
						],
					},
					{
						t: "li",
						c: [
							"Pasting links over selected text in code blocks now correctly replaces the text with the link.",
						],
					},
					{
						t: "li",
						c: [
							"When you create a board, a blank child bullet is now added automatically so it looks like a proper board from the start.",
						],
					},
					{
						t: "li",
						c: [
							"You can now uncheck Window ",
							">",
							" Quick Add in the desktop app to disable the global quick-add function and release its hotkey.",
						],
					},
					{
						t: "li",
						c: [
							"WorkFlowy no longer leaves behind a ghost process after being closed — fixes an issue where the app wouldn’t relaunch unless the lingering process was manually killed or the system was rebooted.",
						],
					},
					{
						t: "li",
						c: [
							"Pasting code from the Gemini editor (and potentially others) no longer results in weird empty lines.",
						],
					},
					{
						t: "li",
						c: [
							"The ability to turn bits of text into",
							" ",
							{
								t: "code",
								c: ["inline code snippets"],
							},
							" has been restored, both via the hotkey and the context menu.",
						],
					},
					{
						t: "li",
						c: [
							"It used to be tricky to get back to editing your search after selecting a sub-filter. Now, you can just click the search text to close the sub-menus and keep typing.",
						],
					},
				],
			},
		],
	},
	{
		id: "july29_2025",
		date: "July 29th, 2025",
		title: "2025.10 - Desktop Quick Add, /Move to child, Smart Nodes, Neo Theme, Backspace into Slash Command, main.py no longer parsed as URL",
		body: [
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/neo-theme.png",
					alt: "Neo theme",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Quick Add on Desktop"],
							},
							" Press Win+Alt+N (Windows) or Opt+Cmd+N (Mac) to open a lightweight panel for capturing thoughts from anywhere. Supports Markdown, auto-inserts clipboard text, strips HTML to Markdown, and grabs page titles from links. Notes land in your Inbox.",
						],
					},
					{
						t: "li",
						c: [
							"Use the new ",
							{
								t: "b",
								c: ['"/Move To Child" Slash command'],
							},
							" to quickly move a bullet under another.",
						],
					},
					{
						t: "li",
						c: [
							"Pro subscribers with Labs and AI enabled can now use",
							" ",
							{
								t: "b",
								c: ["Smart Nodes"],
							},
							" – a new node type that generates content to help you plan, summarise, draft, and create inside Workflowy. Try it with /ai or from the Turn into… menu.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["New theme: Neo"],
							},
							" - When Dark isn’t dark enough.",
						],
					},
					{
						t: "li",
						c: [
							"You can now ",
							{
								t: "b",
								c: ["backspace into a slash command"],
							},
							' if you make a typo while searching for one. For example, typing "',
							{
								t: "code",
								c: ["/mtv"],
							},
							"\" isn’t recognized as a command and exits slash mode. Press Backspace — you're back in the game with /mt , and slash mode is reactivated.",
						],
					},
					{
						t: "li",
						c: [
							"Fragments like ",
							{
								t: "b",
								c: ['"main.py"'],
							},
							" (and some other common file extensions) are ",
							{
								t: "b",
								c: ["no longer parsed as URLs"],
							},
							' unless they include a protocol (e.g. https://main.py). You can now manually unlink any existing ".py" in your outline (automatically doing this on our side would be too risky). Let us know if you come across any other cases where file names get linked unintentionally.',
						],
					},
				],
			},
			{
				t: "p",
				c: ["Other"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"In Markdown Export, To-do items are now rendered as ",
							{
								t: "code",
								c: ["- [ ]"],
							},
							" ",
							"and ",
							{
								t: "code",
								c: ["- [x]"],
							},
							" ",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "code",
								c: ["http://www"],
							},
							" and ",
							{
								t: "code",
								c: ["https://www"],
							},
							" are added as exceptions and no longer parsed as a valid URL",
							" ",
						],
					},
					{
						t: "li",
						c: [
							"Links inside ",
							{
								t: "code",
								c: ["code snippets"],
							},
							" are now ignored — for example,",
							" ",
							{
								t: "code",
								c: ["example.com"],
							},
							" will be rendered as plain text instead of a clickable link in all new snippets.",
							" ",
						],
					},
					{
						t: "li",
						c: ["Dates added by autocomplete no longer have weird spaces. "],
					},
					{
						t: "li",
						c: [
							'In addition to pressing Tab, you can now also click the popup that appears when you type "today" to autocomplete the date',
						],
					},
					{
						t: "li",
						c: ["Children of starred bullets are now draggable in and from the sidebar."],
					},
					{
						t: "li",
						c: [
							'The "gear" icon in the date auto-complete pop-up now correctly leads to the Dates section of the settings.',
						],
					},
				],
			},
		],
	},
	{
		id: "july22_2025",
		date: "July 22nd, 2025",
		title: "2025.9 - Android Sharing to Workflowy improvements, Date auto-complete, Link search",
		body: [
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/date-input-update.gif",
					alt: "Date input improvement",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Date keywords that run into another word - e.g.",
							" ",
							{
								t: "code",
								c: ["today|Buy milk at the store"],
							},
							" - now trigger date auto-complete.",
						],
					},
					{
						t: "li",
						c: [
							"You can now share images directly to your Workflowy inbox on Android. Just long-press an image, tap Share, and select Workflowy.",
						],
					},
					{
						t: "li",
						c: [
							"When sharing on Android from apps like Google Keep, the original note title is now preserved in Workflowy.",
						],
					},
					{
						t: "li",
						c: ["Fixed an issue on Android where shared text duplicated the first line or got truncated."],
					},
					{
						t: "li",
						c: ["Fixed misaligned text when dragging a node on iOS and Android."],
					},
					{
						t: "li",
						c: ["Sign in with your Google account on Android."],
					},
					{
						t: "li",
						c: [
							"Added a link: search operator to find specific URLs, even if the link text has been changed.",
						],
					},
					{
						t: "li",
						c: ["The Focus button in Chat with Your Notes now looks like… an actual button."],
					},
				],
			},
		],
	},
	{
		id: "july15_2025",
		date: "July 15th, 2025",
		title: "2025.8 - Patch notes",
		body: [
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/date-sorting.gif",
					alt: "Sorting dates",
				},
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Sorting now correctly recognizes dates at the start of bullets."],
					},
					{
						t: "li",
						c: ["The Divider is bolder and easier to spot."],
					},
					{
						t: "li",
						c: ["The Date Picker Range toggle respects your preferred week-start day."],
					},
					{
						t: "li",
						c: [
							"Markdown paste now supports ",
							{
								t: "code",
								c: ["[ ] todo"],
							},
							" syntax.",
						],
					},
					{
						t: "li",
						c: [
							"You can now search for Dividers using ",
							{
								t: "code",
								c: ["is:divider"],
							},
							" .",
						],
					},
					{
						t: "li",
						c: [
							"Color highlighted text now exports with ",
							{
								t: "code",
								c: [" <mark>"],
							},
							" ",
							"tags in OPML.",
						],
					},
					{
						t: "li",
						c: ["Completing a Mirrored bullet shows the satisfying completion animation."],
					},
					{
						t: "li",
						c: ["The '#template' button no longer hijacks your cursor when arrowing past it."],
					},
					{
						t: "li",
						c: ["Mentions no longer clutter your sidebar if you’ve turned that off in Settings."],
					},
					{
						t: "li",
						c: ["You can’t Mirror or create Backlinks to the Home bullet anymore (for good reason)."],
					},
					{
						t: "li",
						c: [
							"The ",
							{
								t: "code",
								c: ["/template"],
							},
							" slash command now works on zoomed-in bullet titles.",
						],
					},
					{
						t: "li",
						c: ["Backlinks now behave on macOS 26. "],
					},
				],
			},
		],
	},
	{
		id: "july08_2025",
		date: "July 8th, 2025",
		title: "2025.7 - Color and Highlight multiple bullets at once, Divider improvements",
		body: [
			{
				t: "p",
				c: [
					"Ever wanted to color or highlight multiple bullets at the same time? Now you can. Select several bullets, then bold, italicise, color, or highlight them together from the multi-select menu.",
				],
			},
			{
				t: "img",
				p: {
					src: "https://beta.workflowy.com/media/whats-new/multi-select-highlight.gif",
					alt: "Multi-select menu",
				},
			},
			{
				t: "p",
				c: ['Dividers now look like Dividers in the side-bar. No more weird "Untitled" nodes.'],
			},
			{
				t: "p",
				c: [
					"Tapping a Divider whilst scrolling on Android used to pop open the keyboard and interrupt your flow. That's now fixed.",
				],
			},
		],
	},
	{
		id: "july01_2025",
		date: "July 1st, 2025",
		title: "2025.6 - Add Dividers to break up long lists",
		body: [
			{
				t: "p",
				c: [
					"Lists are great. We love lists. But long lists can be hard to read, and it's easy to scroll away and lose your place.",
				],
			},
			{
				t: "p",
				c: [
					"Dividers help break things up. Use them to create visual sections, add a bit of structure, and make your notes easier to scan.",
				],
			},
			{
				t: "p",
				c: [
					"Type ",
					{
						t: "code",
						c: ["---"],
					},
					" at the start of a bullet, use the",
					" ",
					{
						t: "code",
						c: ["/divider"],
					},
					" slash command, or select it from the bullet menu. They show up in exports and print-outs too.",
				],
			},
		],
	},
	{
		id: "june24_2025",
		date: "June 24th, 2025",
		title: "2025.5 - Choose start of the week, Log in with Google, Android Back button no longer quits the app",
		body: [
			{
				t: "h2",
				c: ["Choose start of the week"],
			},
			{
				t: "p",
				c: [
					"Finally! You can choose which day the week starts on. Monday or Sunday. You decide, we won't judge. Open the Settings, scroll to 'Dates', and choose an option.",
				],
			},
			{
				t: "p",
				c: [
					"Now, when you search for 'this week', type 'this week' in a bullet for auto-complete, or view the Date Picker, the week will start from your chosen option.",
				],
			},
			{
				t: "h2",
				c: ["Other changes"],
			},
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Log in with your Google account:"],
							},
							" On the web, and in the desktop apps, you can now sign up and log in to Workflowy with your Google account. One click. No passwords, no codes, a bit less friction.",
						],
					},
					{
						t: "li",
						c: [
							{
								t: "b",
								c: ["Pressing Back on Android no longer quits the app."],
							},
							" Quitting Workflowy by mistake on Android used to be frustratingly easy. One accidental swipe or tap of the Back button could instantly close the app. Now, if there’s nowhere left to go back to, you’ll see a small warning message. Swiping or pressing back again will close the app.",
						],
					},
					{
						t: "li",
						c: [
							"Use ",
							{
								t: "code",
								c: ["link:[url]"],
							},
							" to search for the URL within a link.",
						],
					},
					{
						t: "li",
						c: ["AI button is hidden when you print the your content."],
					},
				],
			},
		],
	},
	{
		id: "june17_2025",
		date: "June 17th, 2025",
		title: "2025.4 - Patch Notes",
		body: [
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: ["Shared lists are now View-only by default, whether shared by link or email."],
					},
					{
						t: "li",
						c: ["View-only users can no longer check off Todos in shared lists."],
					},
					{
						t: "li",
						c: [
							"Choosing a formatting option in the multi-select menu now keeps bullets highlighted and the menu open, so you can try different styles.",
						],
					},
					{
						t: "li",
						c: ["Nested searches in the Link menu were showing incorrect results."],
					},
					{
						t: "li",
						c: ["is:mirror and is:backlink searches now expand correctly."],
					},
					{
						t: "li",
						c: [
							"Pressing Enter no longer submits messages early when converting Japanese text in Chat with your Notes.",
						],
					},
					{
						t: "li",
						c: ["Markdown lists are now respected when pasted to Workflowy."],
					},
				],
			},
		],
	},
	{
		id: "june11_2025",
		date: "June 11th, 2025",
		title: "2025.3 - A simpler way to use #template",
		body: [
			{
				t: "p",
				c: [
					"Templates used to live in a fixed spot. To use one, you had to find the template button, create an instance, and then drag it to where you actually needed it. It worked, but it added a few too many steps — especially if you use templates often.",
				],
			},
			{
				t: "p",
				c: [
					"Now, just type ",
					{
						t: "code",
						c: ["/Add from template"],
					},
					" (or",
					" ",
					{
						t: "code",
						c: ["/template"],
					},
					" for short) anywhere to insert one of your saved templates in place. This makes templates easier to reach and easier to use.",
				],
			},
		],
	},
	{
		id: "may27_2025",
		date: "May 27th, 2025",
		title: "2025.2 - Patch Notes",
		body: [
			{
				t: "ul",
				c: [
					{
						t: "li",
						c: [
							"Fixed issues where mirrored items were missing from search results. We've also added a toggle to control whether mirrors are included in search, so you can choose to show or hide them.",
						],
					},
					{
						t: "li",
						c: ['"Mirror" icon is now correct on the mobile toolbar.'],
					},
					{
						t: "li",
						c: [
							'"Mentions" and "Drafts" are now hidden from the Left Bar when "Fractal Conversations" is disabled in Settings.',
						],
					},
					{
						t: "li",
						c: ["Quoted search strings now return complete results, including dates."],
					},
					{
						t: "li",
						c: [
							"Adding an image or file to a bullet now keeps it as a bullet - no more unwanted paragraph conversions.",
						],
					},
					{
						t: "li",
						c: [
							'"More Examples" and "More Features" buttons now open correctly within the Help panel on desktop application, without launching a new browser tab.',
						],
					},
					{
						t: "li",
						c: ["Markdown lists are now respected when pasted to WorkFlowy"],
					},
				],
			},
		],
	},
];
