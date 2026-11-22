#!/usr/bin/env node
// The daily review's up-front disk check (plugins/gtd/commands/review/daily.md, "Check disks").
//
// Reports which external disks from the 💾 External Hard Drives inventory are mounted, whether
// the NAS share is mounted, and whether the Mac is at home. At home it suggests the most overdue
// unplugged disks (oldest Last Synced first) for the free slots, since at most two fit at once,
// and asks for the NAS when it is missing. Away from home, including tethered to a phone, it
// suggests nothing. Its `available` list feeds `--disks` on compute-llm-dag.mts and
// compute-overdue.mts, which skip tasks whose `Disks:` marker names a missing disk.
//
// Home means the default gateway's MAC is one of `homeGatewayMacs` in .llm/gtd/config.json and
// the Mac is on AC power. The Wi-Fi SSID would be simpler, but macOS redacts it.
//
// Usage: node disk-check.mts --inventory <External Hard Drives node get JSON> [--config path]

import {execSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {readTreeFile, stripMarkup} from "./compute-overdue.mts";
import type {TreeNode} from "./compute-overdue.mts";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";
import {NAS_DISK} from "./disk-marker.mts";

export const MAX_DISKS = 2;
const NAS_PATH = "/Volumes/Public/NAS";
const SYSTEM_VOLUMES = new Set(["macintosh hd", "public"]);
const LAST_SYNCED_PATTERN = /^Last Synced:\s*(\d{4}-\d{2}-\d{2})/u;
const MAC_PATTERN = /\bat ((?:[\da-f]{1,2}:){5}[\da-f]{1,2})\b/iu;

export interface InventoryDisk
{
	name: string;
	lastSynced: string | null;
}

/** Each drive under the inventory's `Inventory` node: its volume name (the text before any " (") and Last Synced date. */
export function parseInventory(root: TreeNode): InventoryDisk[]
{
	const inventory = (root.children ?? []).find((child) => stripMarkup(child.name).trim() === "Inventory");
	return (inventory?.children ?? [])
		.map((drive) =>
		{
			const name = stripMarkup(drive.name).split(" (")[0]?.trim() ?? "";
			const lastSynced = (drive.children ?? [])
				.map((child) => stripMarkup(child.name).trim().match(LAST_SYNCED_PATTERN)?.[1])
				.find((date) => date !== undefined);
			return {
				name,
				lastSynced: lastSynced ?? null,
			};
		})
		.filter((drive) => drive.name !== "");
}

export function parseGatewayMac(arpOutput: string): string | null
{
	return arpOutput.match(MAC_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function parseOnAcPower(pmsetOutput: string): boolean
{
	return pmsetOutput.includes("'AC Power'");
}

export interface DiskCheckInput
{
	inventory: InventoryDisk[];
	volumes: readonly string[];
	nasMounted: boolean;
	gatewayMac: string | null;
	onAcPower: boolean;
	homeGatewayMacs: readonly string[];
}

function homeStatus({gatewayMac, onAcPower, homeGatewayMacs}: DiskCheckInput)
{
	const mac = gatewayMac?.toLowerCase() ?? null;
	const homeMacs = new Set(homeGatewayMacs.map((entry) => entry.toLowerCase()));
	const reason =
		homeMacs.size === 0
			? "no homeGatewayMacs in .llm/gtd/config.json"
			: mac === null || !homeMacs.has(mac)
				? `gateway ${mac ?? "unknown"} is not a home router (tethered or away)`
				: onAcPower
					? "gateway is a home router and the Mac is on AC power"
					: "on battery power";
	return {
		atHome: homeMacs.size > 0 && mac !== null && homeMacs.has(mac) && onAcPower,
		gatewayMac: mac,
		onAcPower,
		reason,
	};
}

export function checkDisks(input: DiskCheckInput)
{
	const home = homeStatus(input);
	const byVolume = new Map(input.inventory.map((disk) => [disk.name.toLowerCase(), disk]));
	const userVolumes = input.volumes.filter(
		(volume) =>
			!volume.startsWith("com.apple.") && !volume.startsWith(".") && !SYSTEM_VOLUMES.has(volume.toLowerCase()),
	);
	const mounted = userVolumes.flatMap((volume) => byVolume.get(volume.toLowerCase()) ?? []);
	const unknownVolumes = userVolumes.filter((volume) => !byVolume.has(volume.toLowerCase()));
	const mountedNames = new Set(mounted.map((disk) => disk.name));
	const freeSlots = Math.max(0, MAX_DISKS - mounted.length);
	const suggest = home.atHome
		? input.inventory
				.filter(
					(
						disk,
					): disk is InventoryDisk &
					{
						lastSynced: string;
					} => disk.lastSynced !== null && !mountedNames.has(disk.name),
				)
				.toSorted((a, b) => a.lastSynced.localeCompare(b.lastSynced))
				.slice(0, freeSlots)
		: [];
	return {
		home,
		maxDisks: MAX_DISKS,
		mounted,
		unknownVolumes,
		nasMounted: input.nasMounted,
		available: [...mounted.map((disk) => disk.name), ...(input.nasMounted ? [NAS_DISK] : [])],
		suggest,
		askMountNas: home.atHome && !input.nasMounted,
		undated: input.inventory.filter((disk) => disk.lastSynced === null).map((disk) => disk.name),
	};
}

function run(command: string): string
{
	try
	{
		return execSync(
			command,
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	}
	catch
	{
		return "";
	}
}

function configuredHomeGatewayMacs(configPath: string): string[]
{
	if (!existsSync(configPath))
	{
		return [];
	}
	const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	const macs =
		typeof config === "object" && config !== null && "homeGatewayMacs" in config
			? config.homeGatewayMacs
			: undefined;
	return Array.isArray(macs) ? macs.filter((mac): mac is string => typeof mac === "string") : [];
}

function main(argv: string[]): void
{
	let inventoryPath: string | null = null;
	let configPath = ".llm/gtd/config.json";
	const argIterator = argv.slice(2)[Symbol.iterator]();
	for (const arg of argIterator)
	{
		if (arg === "--inventory")
		{
			inventoryPath = takeValue(argIterator, arg);
		}
		else if (arg === "--config")
		{
			configPath = takeValue(argIterator, arg);
		}
		else
		{
			throw new Error(`unknown option: ${arg}`);
		}
	}
	if (inventoryPath === null)
	{
		throw new Error("--inventory is required");
	}
	const gateway = run("route -n get default").match(/gateway:\s*(\S+)/u)?.[1];
	const result = checkDisks(
		{
			inventory: parseInventory(readTreeFile(inventoryPath)),
			volumes: readdirSync("/Volumes"),
			nasMounted: existsSync(NAS_PATH),
			gatewayMac: gateway ? parseGatewayMac(run(`arp -n ${gateway}`)) : null,
			onAcPower: parseOnAcPower(run("pmset -g batt")),
			homeGatewayMacs: configuredHomeGatewayMacs(configPath),
		},
	);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMain(import.meta.url))
{
	main(process.argv);
}
