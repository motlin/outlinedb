import {text} from "node:stream/consumers";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {createNodeTree, NodeTreeSpecSchema, PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {CreatedNodeTree, NodeTreeSpec} from "@outlinedb/shared/cache";
import {getWorkflowyUrl, hasInternalLink} from "@outlinedb/shared/workflowy";
import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {syncBacklinksIfLinked, internalAdapter} from "@outlinedb/shared/node";
import {logger} from "../../services/logger.js";
import {resolveOrCreateNodePath, resolveParent} from "@outlinedb/shared/utils";
import {adoptUnderCalendar, calendarMonthPath} from "../../services/calendar-adoption.js";

/**
 * Read all content from stdin as a string
 */
async function readStdin(): Promise<string>
{
	const {stdin} = process;
	if (stdin.isTTY)
	{
		throw new Error("No input provided on stdin. Use --name with a value or pipe content to stdin.");
	}

	return text(stdin);
}

export default class Create extends Command
{
	static override description = "Create a new Workflowy node or tree of nodes from JSON";

	static override examples = [
		"# Create node in inbox (system target)",
		'<%= config.bin %> <%= command.id %> --parent-id inbox --name "New Task"',
		"",
		"# Create a top-level node (Home)",
		'<%= config.bin %> <%= command.id %> --parent-id home --name "Area"',
		"",
		"# Create node under a parent by ID",
		'<%= config.bin %> <%= command.id %> --parent-id abc123 --name "Subtask"',
		"",
		"# Create node under a parent by path",
		'<%= config.bin %> <%= command.id %> --parent-path "Work,Projects" --name "Subtask"',
		"",
		"# Create node with a specific layout mode",
		'<%= config.bin %> <%= command.id %> --parent-id abc123 --name "Notes" --layout-mode document',
		"",
		"# Create from stdin (use - for name)",
		String.raw`echo "## Section 1\n\nParagraph text" | <%= config.bin %> <%= command.id %> --parent-id abc123 --name -`,
		"",
		"# Import article content via clean-mark",
		"npx clean-mark https://example.com/article --stdout | <%= config.bin %> <%= command.id %> --parent-id abc123 --name -",
		"",
		"# Preview the API call without creating",
		'<%= config.bin %> <%= command.id %> --parent-id inbox --name "New Task" --dry-run',
		"",
		"# Create nested nodes from inline JSON",
		'<%= config.bin %> <%= command.id %> --parent-id abc123 --json \'{"name": "Project", "children": [{"name": "Task 1"}, {"name": "Task 2"}]}\'',
		"",
		"# Create nested nodes from a JSON file",
		"<%= config.bin %> <%= command.id %> --parent-id abc123 --json-file ./project-template.json",
		"",
		"# Create node under a path, creating missing segments (like mkdir -p)",
		'<%= config.bin %> <%= command.id %> --parent-path "Metadata,Scanner State,my-scanner" --name "state.json" --create-path',
	];

	static override flags =
	{
		name: Flags.string(
			{
				char: "n",
				description:
					'Name of the new node (use "-" to read from stdin; an indented bullet outline becomes a nested tree per top-level bullet)',
				exclusive: ["json", "json-file"],
			},
		),
		json: Flags.string(
			{
				description: "JSON structure defining a tree of nodes to create",
				exclusive: ["name", "note", "layout-mode", "json-file"],
			},
		),
		"json-file": Flags.string(
			{
				description: "Path to a JSON file defining a tree of nodes to create",
				exclusive: ["name", "note", "layout-mode", "json"],
			},
		),
		"parent-id": Flags.string(
			{
				description: 'ID of parent node, a system target (e.g., "inbox"), or "home" for the top level',
				exclusive: ["parent-path"],
			},
		),
		"parent-path": Flags.string(
			{
				description: 'Comma-separated path to parent node (e.g., "Work,Projects")',
				exclusive: ["parent-id"],
			},
		),
		note: Flags.string(
			{
				description: "Note/description for the node",
			},
		),
		"layout-mode": Flags.string(
			{
				description: 'Layout mode for the node (e.g., "document", "list", "board")',
			},
		),
		position: Flags.option(
			{
				description: 'Position among siblings: "top" (first) or "bottom" (last, default)',
				options: ["top", "bottom"] as const,
			},
		)(),
		"dry-run": Flags.boolean(
			{
				char: "d",
				description: "Show the API call that would be made without executing",
				default: false,
			},
		),
		"create-path": Flags.boolean(
			{
				description: "Create missing parent path segments (like mkdir -p)",
				default: false,
			},
		),
	};

	public async run(): Promise<void>
	{
		const {flags} = await this.parse(Create);
		// oclif types parsed flags as `F & {json: boolean | undefined}`, which collapses this string flag to `undefined`.
		const {json: jsonFlag} = flags as
		{
			json?: string;
		};

		const apiKey = process.env.WORKFLOWY_API_KEY;
		if (!apiKey)
		{
			this.error("WORKFLOWY_API_KEY environment variable is required");
		}

		// Validate that either --name or --json/--json-file is provided
		if (flags.name === undefined && !jsonFlag && !flags["json-file"])
		{
			this.error("Either --name, --json, or --json-file is required");
		}

		const apiClient = new WorkflowyApiClient(apiKey, logger, process.env.WORKFLOWY_API_URL);
		const database = createDatabase();
		const cacheService = new CacheService(database);
		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);

		// Validate that at least one parent specifier is provided
		if (!flags["parent-id"] && !flags["parent-path"])
		{
			this.error("Parent node is required. Use --parent-id or --parent-path to specify a parent.");
		}

		// Resolve parent ID, optionally creating missing path segments
		// Note: --create-path is ignored with --dry-run to avoid creating real nodes
		const parentId =
			flags["create-path"] && flags["parent-path"] && !flags["dry-run"]
				? await this.resolveCreatePath(flags["parent-path"], cacheService, apiClient, client, database)
				: await resolveParent(
						{
							id: flags["parent-id"],
							path: flags["parent-path"],
						},
						cacheService,
						apiClient,
					);

		// Handle JSON input mode
		if (jsonFlag || flags["json-file"])
		{
			await this.runJsonMode(flags, parentId, apiClient, cacheService, database);
			return;
		}

		// Handle stdin input when --name is "-"
		if (flags.name === undefined)
		{
			this.error("Either --name, --json, or --json-file is required");
		}
		let {name} = flags;
		if (name === "-")
		{
			try
			{
				name = await readStdin();
			}
			catch (error)
			{
				this.error(error instanceof Error ? error.message : "Failed to read from stdin");
			}
		}

		// An indented bullet outline on stdin becomes a node tree per top-level bullet
		const outline = flags.name === "-" ? parseBulletOutline(name) : [];
		if (outline.length > 0)
		{
			// Each tree lands at the same end of the parent, so --position top creates them last-first.
			const ordered = flags.position === "top" ? outline.toReversed() : outline;
			for (const tree of ordered)
			{
				// oxlint-disable-next-line no-await-in-loop -- trees must be created in order
				await this.createTree(tree, flags, parentId, apiClient, cacheService, database);
			}
			return;
		}

		// Handle single node creation mode (original behavior)
		await this.runSingleNodeMode(
			{
				...flags,
				name,
			},
			parentId,
			client,
			database,
		);
	}

	/**
	 * `--create-path`: create missing parent segments. A missing year or month of the 📆 Calendar is ensured through
	 * the internal API (upstream-shaped, with `calendar` metadata) so workflowy.com uses it; a name-only one would be
	 * invisible there. Without internal auth the segments are created by name, with a warning.
	 */
	private async resolveCreatePath(
		parentPath: string,
		cacheService: CacheService,
		apiClient: WorkflowyApiClient,
		client: WorkflowyWriteThroughClient,
		database: ReturnType<typeof createDatabase>,
	): Promise<string>
	{
		const calendarPath = calendarMonthPath(parentPath);
		if (calendarPath === undefined)
		{
			return resolveOrCreateNodePath(parentPath, cacheService, apiClient);
		}
		const adapter = internalAdapter(database, client);
		if (adapter === undefined)
		{
			if (
				cacheService.findNodeByPath(
					parentPath
						.split(",")
						.slice(0, 3)
						.map((part) => part.trim()),
				) === null
			)
			{
				this.logToStderr(
					`warning: ${parentPath} will be created by name, without 📆 Calendar metadata; workflowy.com will not use those year/month nodes. Set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run ./bin/run.js calendar day --date ${calendarPath.year}-${String(calendarPath.month).padStart(2, "0")}-01 --ensure instead.`,
				);
			}
			return resolveOrCreateNodePath(parentPath, cacheService, apiClient);
		}
		const {dayId} = await adapter.ensureCalendarDay(
			calendarPath.dateId,
			{
				stopAt: "month",
				createChild: false,
			},
		);
		let current = dayId;
		for (const segment of calendarPath.rest)
		{
			const existing = cacheService.getChildByName(current, segment);
			current =
				existing?.id ??
				(
					await client.createNode(
						{
							parent_id: current,
							name: segment,
						},
					)
				).id;
		}
		return current;
	}

	/**
	 * Create a single node (original behavior)
	 */
	private async runSingleNodeMode(
		flags:
		{
			name: string;
			note?: string;
			"layout-mode"?: string;
			position?: "top" | "bottom";
			"dry-run": boolean;
		},
		parentId: string | null,
		client: WorkflowyWriteThroughClient,
		database: ReturnType<typeof createDatabase>,
	): Promise<void>
	{
		const {name} = flags;

		if (flags["dry-run"])
		{
			// Home has no API key: a top-level create omits parent_id.
			const requestBody:
			{
				parent_id?: string;
				name: string;
				note?: string;
				layoutMode?: string;
			} =
				parentId === null
					?
						{
							name,
						}
					:
						{
							parent_id: parentId,
							name,
						};
			if (flags.note)
			{
				requestBody.note = flags.note;
			}
			if (flags["layout-mode"])
			{
				requestBody.layoutMode = flags["layout-mode"];
			}

			this.log("Would execute API call:");
			this.log("  Method: POST");
			this.log("  URL: https://workflowy.com/api/v1/nodes/");
			this.log("  Headers:");
			this.log("    Authorization: Bearer <WORKFLOWY_API_KEY>");
			this.log("    Content-Type: application/json");
			this.log("  Body:");
			this.log(`    ${JSON.stringify(requestBody, null, 2).split("\n").join("\n    ")}`);

			const pathBuilder = new PathBuilder(database);
			const parentPath = pathBuilder.buildFullPath(parentId);
			this.log("");
			this.log(`Parent: ${parentPath}`);
		}
		else
		{
			this.log(`Creating node: ${name}`);
			const pathBuilder = new PathBuilder(database);
			const parentPath = pathBuilder.buildFullPath(parentId);
			this.log(`Parent: ${parentPath}`);

			const newNode = await client.createNode(
				{
					parent_id: parentId,
					name,
					note: flags.note,
					layoutMode: flags["layout-mode"],
					position: flags.position,
				},
			);
			await syncBacklinksIfLinked([newNode.id], [name, flags.note], database, client);
			await adoptUnderCalendar(
				{
					rows: [
						{
							id: newNode.id,
							name,
						},
					],
					parentId,
					database,
					cache: new CacheService(database),
					writeThrough: client,
					warn: (message) =>
					{
						this.logToStderr(message);
					},
				},
			);

			this.log("");
			this.log("Successfully created node");
			this.log(`  ID: ${newNode.id}`);
			this.log(`  Name: ${newNode.name}`);
			this.log(`  Created: ${new Date(newNode.createdAt * 1000).toISOString()}`);
			this.log(`  URL: ${getWorkflowyUrl(newNode.id)}`);
		}
	}

	/**
	 * Create nodes from JSON input (tree structure)
	 */
	private async runJsonMode(
		flags:
		{
			json?: string;
			"json-file"?: string;
			"dry-run": boolean;
			position?: "top" | "bottom";
		},
		parentId: string | null,
		apiClient: WorkflowyApiClient,
		cacheService: CacheService,
		database: ReturnType<typeof createDatabase>,
	): Promise<void>
	{
		// Parse JSON input
		let jsonInput: unknown;
		if (flags.json)
		{
			try
			{
				jsonInput = JSON.parse(flags.json);
			}
			catch
			{
				this.error("Invalid JSON in --json flag");
			}
		}
		else if (flags["json-file"])
		{
			const filePath = flags["json-file"];
			if (!fs.existsSync(filePath))
			{
				this.error(`File not found: ${filePath}`);
			}
			try
			{
				const fileContent = fs.readFileSync(filePath, "utf8");
				jsonInput = JSON.parse(fileContent);
			}
			catch
			{
				this.error(`Failed to parse JSON from file: ${filePath}`);
			}
		}

		// Validate JSON structure
		const parseResult = NodeTreeSpecSchema.safeParse(jsonInput);
		if (!parseResult.success)
		{
			this.error(`Invalid JSON structure: ${parseResult.error.message}`);
		}

		await this.createTree(parseResult.data, flags, parentId, apiClient, cacheService, database);
	}

	/**
	 * Create one node tree under the parent (or preview it with --dry-run)
	 */
	private async createTree(
		nodeTree: NodeTreeSpec,
		flags:
		{
			"dry-run": boolean;
			position?: "top" | "bottom";
		},
		parentId: string | null,
		apiClient: WorkflowyApiClient,
		cacheService: CacheService,
		database: ReturnType<typeof createDatabase>,
	): Promise<void>
	{
		if (flags["dry-run"])
		{
			this.dryRunJsonMode(nodeTree, parentId, database);
			return;
		}

		// Create nodes recursively
		this.log("Creating node tree...");
		const pathBuilder = new PathBuilder(database);
		const parentPath = pathBuilder.buildFullPath(parentId);
		this.log(`Parent: ${parentPath}`);
		this.log("");

		const client = new WorkflowyWriteThroughClient(apiClient, cacheService);
		const result = await createNodeTree(nodeTree, parentId, client, flags.position);
		const linked = linkedCreatedNodes(nodeTree, result);
		await syncBacklinksIfLinked(
			linked.map(({id}) => id),
			linked.map((node) => node.text),
			database,
			client,
		);

		await adoptUnderCalendar(
			{
				rows: [
					{
						id: result.id,
						name: nodeTree.name,
					},
				],
				parentId,
				database,
				cache: cacheService,
				writeThrough: client,
				warn: (message) =>
				{
					this.logToStderr(message);
				},
			},
		);

		// Output results
		this.log("Successfully created node tree:");
		this.printCreatedTree(result, 0);

		// Output JSON result for programmatic use
		this.log("");
		this.log("Created node IDs (JSON):");
		this.log(JSON.stringify(this.flattenCreatedNodes(result), null, 2));
	}

	/**
	 * Print the created tree structure
	 */
	private printCreatedTree(node: CreatedNodeTree, depth: number): void
	{
		const indent = "  ".repeat(depth);
		this.log(`${indent}- ${node.name}`);
		this.log(`${indent}  ID: ${node.id}`);
		this.log(`${indent}  URL: ${getWorkflowyUrl(node.id)}`);

		for (const child of node.children)
		{
			this.printCreatedTree(child, depth + 1);
		}
	}

	/**
	 * Flatten created nodes into an array of {id, name, parentId} objects
	 */
	private flattenCreatedNodes(
		node: CreatedNodeTree,
		parentId?: string,
	):
	{
		id: string;
		name: string;
		parentId: string | null;
	}[]
	{
		const result:
		{
			id: string;
			name: string;
			parentId: string | null;
		}[] = [
			{
				id: node.id,
				name: node.name,
				parentId: parentId ?? null,
			},
		];

		for (const child of node.children)
		{
			result.push(...this.flattenCreatedNodes(child, node.id));
		}

		return result;
	}

	/**
	 * Show dry-run output for JSON mode
	 */
	private dryRunJsonMode(
		nodeTree: NodeTreeSpec,
		parentId: string | null,
		database: ReturnType<typeof createDatabase>,
	): void
	{
		this.log("Would create the following node tree:");
		this.log("");

		const pathBuilder = new PathBuilder(database);
		const parentPath = pathBuilder.buildFullPath(parentId);
		this.log(`Parent: ${parentPath}`);
		this.log("");

		this.printNodeTreePreview(nodeTree, 0);

		this.log("");
		this.log("API calls that would be made:");
		const nodeCount = this.countNodes(nodeTree);
		this.log(`  ${nodeCount} POST requests to https://workflowy.com/api/v1/nodes/`);
	}

	/**
	 * Print a preview of the node tree that would be created
	 */
	private printNodeTreePreview(node: NodeTreeSpec, depth: number): void
	{
		const indent = "  ".repeat(depth);
		this.log(`${indent}- ${node.name}`);
		if (node.note)
		{
			this.log(`${indent}  Note: ${node.note.slice(0, 50)}${node.note.length > 50 ? "..." : ""}`);
		}
		if (node.layoutMode)
		{
			this.log(`${indent}  Layout: ${node.layoutMode}`);
		}

		if (node.children)
		{
			for (const child of node.children)
			{
				this.printNodeTreePreview(child, depth + 1);
			}
		}
	}

	/**
	 * Count total nodes in a tree
	 */
	private countNodes(node: NodeTreeSpec): number
	{
		let count = 1;
		if (node.children)
		{
			for (const child of node.children)
			{
				count += this.countNodes(child);
			}
		}
		return count;
	}
}

/** Each created node whose spec text holds an internal link, with that text, depth-first. */
function linkedCreatedNodes(
	spec: NodeTreeSpec,
	created: CreatedNodeTree,
):
{
	id: string;
	text: string;
}[]
{
	const specText = `${spec.name} ${spec.note ?? ""}`;
	return [
		...(hasInternalLink(specText)
			? [
					{
						id: created.id,
						text: specText,
					},
				]
			: []),
		...(spec.children ?? []).flatMap((child, index) =>
		{
			const createdChild = created.children[index];
			return createdChild === undefined ? [] : linkedCreatedNodes(child, createdChild);
		}),
	];
}

const BULLET_LINE = /^(?<indent>[ \t]*)[-*+][ \t]+(?<text>.*)$/u;

/**
 * Parse a markdown bullet outline into one tree per top-level bullet, nesting by indentation
 * (a tab counts as four spaces). Blank lines are skipped. Returns [] when any other line is not a
 * bullet, so headings, paragraphs, and continuation lines keep the single-node path.
 */
function parseBulletOutline(input: string): NodeTreeSpec[]
{
	const roots: NodeTreeSpec[] = [];
	const stack:
	{
		indent: number;
		node: NodeTreeSpec;
	}[] = [];
	for (const line of input.split(/\r?\n/u))
	{
		if (line.trim() === "")
		{
			continue;
		}
		const match = BULLET_LINE.exec(line);
		const {indent: indentText, text: bulletText} = match?.groups ?? {};
		if (indentText === undefined || bulletText === undefined)
		{
			return [];
		}
		const indent = indentText.replaceAll("\t", "    ").length;
		const node: NodeTreeSpec =
		{
			name: bulletText.trimEnd(),
		};
		while ((stack.at(-1)?.indent ?? -1) >= indent)
		{
			stack.pop();
		}
		const parent = stack.at(-1)?.node;
		if (parent === undefined)
		{
			roots.push(node);
		}
		else
		{
			(parent.children ??= []).push(node);
		}
		stack.push(
			{
				indent,
				node,
			},
		);
	}
	return roots;
}
