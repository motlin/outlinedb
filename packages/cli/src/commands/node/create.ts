import {text} from "node:stream/consumers";
import {WorkflowyApiClient} from "@outlinedb/shared/api";
import {NodeTreeSpecSchema, PathBuilder, WorkflowyWriteThroughClient} from "@outlinedb/shared/cache";
import type {NodeTreeSpec} from "@outlinedb/shared/cache";
import type {NewTree} from "@outlinedb/shared/internal";
import {getWorkflowyUrl, hasInternalLink} from "@outlinedb/shared/workflowy";
import {Command, Flags} from "@oclif/core";
import fs from "node:fs";
import {createDatabase} from "../../db/index.js";
import {CacheService} from "../../services/cache.js";
import {logger} from "../../services/logger.js";
import {drainAfterWrite, localParent, openLocalWrites, resolveOrCreateLocalPath} from "../../services/local-writes.js";
import type {LocalWrites} from "../../services/local-writes.js";
import {resolveParent} from "@outlinedb/shared/utils";
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

		// Read the input before anything is written: a JSON tree, an outline on stdin (a tree per top-level bullet), or a name.
		const fromJson = Boolean(jsonFlag) || Boolean(flags["json-file"]);
		const name = fromJson ? "" : flags.name === "-" ? await this.readStdinName() : (flags.name ?? "");
		const trees = fromJson
			? [
					this.readJsonTree(
						{
							json: jsonFlag,
							"json-file": flags["json-file"],
						},
					),
				]
			: flags.name === "-"
				? parseBulletOutline(name)
				: [];

		// Writes go to the local tables, then one drain delivers them; --dry-run writes nothing.
		const writes = flags["dry-run"] ? undefined : openLocalWrites(database, client);

		// Resolve parent ID, optionally creating missing path segments
		const parentId =
			flags["create-path"] && flags["parent-path"] && writes !== undefined
				? await this.resolveCreatePath(flags["parent-path"], cacheService, writes)
				: await resolveParent(
						{
							id: flags["parent-id"],
							path: flags["parent-path"],
						},
						cacheService,
						apiClient,
					);

		if (trees.length > 0)
		{
			await this.createTrees(trees, flags, parentId, cacheService, database, writes);
			return;
		}
		await this.runSingleNodeMode(
			{
				...flags,
				name,
			},
			parentId,
			cacheService,
			database,
			writes,
		);
	}

	private async readStdinName(): Promise<string>
	{
		let input: string;
		try
		{
			input = await readStdin();
		}
		catch (error)
		{
			this.error(error instanceof Error ? error.message : "Failed to read from stdin");
		}
		return input;
	}

	/**
	 * `--create-path`: create missing parent segments. A missing year or month of the 📆 Calendar is ensured through
	 * the internal API (upstream-shaped, with `calendar` metadata) so workflowy.com uses it; a name-only one would be
	 * invisible there.
	 */
	private async resolveCreatePath(
		parentPath: string,
		cacheService: CacheService,
		writes: LocalWrites,
	): Promise<string>
	{
		const calendarPath = calendarMonthPath(parentPath);
		if (calendarPath === undefined)
		{
			return resolveOrCreateLocalPath(parentPath, cacheService, writes.local);
		}
		const {dayId} = await writes.adapter.ensureCalendarDay(
			calendarPath.dateId,
			{
				stopAt: "month",
				createChild: false,
			},
		);
		let current = dayId;
		for (const segment of calendarPath.rest)
		{
			current =
				cacheService.getChildByName(current, segment)?.id ??
				writes.local.createAt(
					{
						parentId: current,
						name: segment,
					},
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
		cacheService: CacheService,
		database: ReturnType<typeof createDatabase>,
		writes: LocalWrites | undefined,
	): Promise<void>
	{
		const {name} = flags;

		if (writes === undefined)
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

			const targetId = localParent(database, parentId);
			const {id} = writes.local.createAt(
				{
					parentId: targetId,
					name,
					...(flags.note === undefined
						? {}
						:
							{
								note: flags.note,
							}),
					...(flags["layout-mode"] === undefined
						? {}
						:
							{
								layoutMode: flags["layout-mode"],
							}),
					...(flags.position === "top"
						?
							{
								index: 0,
							}
						: {}),
				},
			);
			if (hasInternalLink(`${name} ${flags.note ?? ""}`))
			{
				writes.local.syncBacklinks([id]);
			}
			await adoptUnderCalendar(
				{
					rows: [
						{
							id,
							name,
						},
					],
					parentId: targetId,
					database,
					cache: cacheService,
					local: writes.local,
				},
			);
			await drainAfterWrite(this, writes);

			const createdAt = cacheService.getNode(id)?.createdAt ?? new Date();
			this.log("");
			this.log("Successfully created node");
			this.log(`  ID: ${id}`);
			this.log(`  Name: ${name}`);
			this.log(`  Created: ${createdAt.toISOString()}`);
			this.log(`  URL: ${getWorkflowyUrl(id)}`);
		}
	}

	/**
	 * Create nodes from JSON input (tree structure)
	 */
	/**
	 * The node tree of --json or --json-file
	 */
	private readJsonTree(flags: {json?: string; "json-file"?: string}): NodeTreeSpec
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
		return parseResult.data;
	}

	/**
	 * Create node trees side by side under the parent, in one unit of work (or preview them with --dry-run)
	 */
	private async createTrees(
		specs: readonly NodeTreeSpec[],
		flags:
		{
			position?: "top" | "bottom";
		},
		parentId: string | null,
		cacheService: CacheService,
		database: ReturnType<typeof createDatabase>,
		writes: LocalWrites | undefined,
	): Promise<void>
	{
		if (writes === undefined)
		{
			for (const spec of specs)
			{
				this.dryRunJsonMode(spec, parentId, database);
			}
			return;
		}

		this.log("Creating node tree...");
		const pathBuilder = new PathBuilder(database);
		const parentPath = pathBuilder.buildFullPath(parentId);
		this.log(`Parent: ${parentPath}`);
		this.log("");

		const created = specs.map((spec) => withIds(spec));
		const targetId = localParent(database, parentId);
		writes.local.createTreesAt(
			{
				parentId: targetId,
				...(flags.position === "top"
					?
						{
							index: 0,
						}
					: {}),
				trees: created.map(({tree}) => tree),
			},
		);
		const linked = created.flatMap(({tree}) => linkedCreatedNodes(tree));
		if (linked.length > 0)
		{
			writes.local.syncBacklinks(linked);
		}
		await adoptUnderCalendar(
			{
				rows: created.map(({node}) => (
				{
					id: node.id,
					name: node.name,
				})),
				parentId: targetId,
				database,
				cache: cacheService,
				local: writes.local,
			},
		);
		await drainAfterWrite(this, writes);

		for (const {node} of created)
		{
			this.log("Successfully created node tree:");
			this.printCreatedTree(node, 0);

			// Output JSON result for programmatic use
			this.log("");
			this.log("Created node IDs (JSON):");
			this.log(JSON.stringify(this.flattenCreatedNodes(node), null, 2));
		}
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

/** A created node and its descendants, as the output lists them. */
interface CreatedNodeTree
{
	id: string;
	name: string;
	children: CreatedNodeTree[];
}

/** A spec as a local tree with an id chosen for every node, and those ids as the output lists them. */
function withIds(spec: NodeTreeSpec):
{
	tree: NewTree;
	node: CreatedNodeTree;
}
{
	const id = crypto.randomUUID();
	const children = (spec.children ?? []).map((child) => withIds(child));
	return {
		tree:
		{
			id,
			name: spec.name,
			...(spec.note === undefined
				? {}
				:
					{
						note: spec.note,
					}),
			...(spec.layoutMode === undefined
				? {}
				:
					{
						metadata:
						{
							layoutMode: spec.layoutMode,
						},
					}),
			children: children.map(({tree}) => tree),
		},
		node:
		{
			id,
			name: spec.name,
			children: children.map(({node}) => node),
		},
	};
}

/** The ids of each node of a tree whose text holds an internal link, depth-first. */
function linkedCreatedNodes(tree: NewTree): string[]
{
	return [
		...(tree.id !== undefined && hasInternalLink(`${tree.name} ${tree.note ?? ""}`) ? [tree.id] : []),
		...(tree.children ?? []).flatMap((child) => linkedCreatedNodes(child)),
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
