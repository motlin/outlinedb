import type {Definition, Schema} from "ts-json-schema-generator";

type SchemaObject = Schema &
{
	definitions?: Record<string, Definition>;
};

export function schemaToInterface(schema: SchemaObject, interfaceName: string): string
{
	const definitions = schema.definitions ?? {};

	// Determine the root type name from the $ref
	const rootRefName = schema.$ref?.replace("#/definitions/", "");

	// Map from definition names to output interface names
	const nameMap = new Map<string, string>();
	if (rootRefName)
	{
		nameMap.set(rootRefName, interfaceName);
	}

	const lines: string[] = [];
	const visited = new Set<string>();

	const rootDefinition = rootRefName === undefined ? undefined : definitions[rootRefName];
	if (rootDefinition === undefined)
	{
		formatObject(schema, interfaceName, lines, definitions, visited, nameMap);
	}
	else
	{
		const rootDef = rootDefinition as SchemaObject;
		formatObject(rootDef, interfaceName, lines, definitions, visited, nameMap);
	}

	return lines.join("\n");
}

function formatObject(
	schema: SchemaObject,
	name: string,
	lines: string[],
	definitions: Record<string, Definition>,
	visited: Set<string>,
	nameMap: Map<string, string>,
): void
{
	if (visited.has(name))
	{
		return;
	}
	visited.add(name);

	const nestedInterfaces:
	{
		schema: SchemaObject;
		name: string;
	}[] = [];

	lines.push(`interface ${name} {`);
	if (schema.properties)
	{
		const required = new Set(schema.required);
		for (const [key, prop] of Object.entries(schema.properties))
		{
			if (typeof prop === "boolean")
			{
				continue;
			}
			const optional = required.has(key) ? "" : "?";
			const typeStr = formatType(prop, definitions, nestedInterfaces, nameMap);
			lines.push(`  ${key}${optional}: ${typeStr};`);
		}
	}
	lines.push("}");

	for (const nested of nestedInterfaces)
	{
		lines.push("");
		formatObject(nested.schema, nested.name, lines, definitions, visited, nameMap);
	}
}

function resolveRef(schema: SchemaObject, definitions: Record<string, Definition>): SchemaObject
{
	if (schema.$ref)
	{
		const refName = schema.$ref.replace("#/definitions/", "");
		const def = definitions[refName];
		if (def !== undefined && typeof def !== "boolean")
		{
			return def;
		}
	}
	return schema;
}

function formatType(
	schema: SchemaObject,
	definitions: Record<string, Definition>,
	nestedInterfaces:
	{
		schema: SchemaObject;
		name: string;
	}[],
	nameMap: Map<string, string>,
): string
{
	if (schema.$ref)
	{
		const refName = schema.$ref.replace("#/definitions/", "");
		const displayName = nameMap.get(refName) ?? refName;
		const def = definitions[refName];
		if (def !== undefined && typeof def !== "boolean")
		{
			const resolved = def as SchemaObject;
			if (resolved.properties)
			{
				nestedInterfaces.push(
					{
						schema: resolved,
						name: displayName,
					},
				);
				return displayName;
			}
			return formatType(resolved, definitions, nestedInterfaces, nameMap);
		}
		return displayName;
	}

	if (schema.anyOf)
	{
		const types = schema.anyOf
			.filter((s) => typeof s !== "boolean")
			.map((s) => formatType(s, definitions, nestedInterfaces, nameMap))
			.filter((t) => t !== "unknown");
		return types.join(" | ");
	}

	if (schema.type === "array")
	{
		const {items} = schema;
		if (items !== undefined && typeof items !== "boolean" && !Array.isArray(items))
		{
			const itemType = formatType(items, definitions, nestedInterfaces, nameMap);
			return itemType.includes("|") ? `(${itemType})[]` : `${itemType}[]`;
		}
		return "unknown[]";
	}

	if (schema.type === "object" && schema.properties)
	{
		const parts: string[] = [];
		const required = new Set(schema.required);
		for (const [key, prop] of Object.entries(schema.properties))
		{
			if (typeof prop === "boolean")
			{
				continue;
			}
			const resolved = resolveRef(prop, definitions);
			const optional = required.has(key) ? "" : "?";
			const typeStr = formatType(resolved, definitions, nestedInterfaces, nameMap);
			parts.push(`${key}${optional}: ${typeStr}`);
		}
		return `{ ${parts.join("; ")} }`;
	}

	if (Array.isArray(schema.type))
	{
		return schema.type.map((t) => mapPrimitive(t)).join(" | ");
	}

	if (typeof schema.type === "string")
	{
		return mapPrimitive(schema.type);
	}

	return "unknown";
}

function mapPrimitive(type: string): string
{
	switch (type)
	{
		case "integer":
		{
			return "number";
		}
		case "null":
		{
			return "null";
		}
		default:
		{
			return type;
		}
	}
}
