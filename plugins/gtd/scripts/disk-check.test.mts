// Run: node --test plugins/gtd/scripts/disk-check.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {checkDisks, parseGatewayMac, parseInventory, parseOnAcPower} from "./disk-check.mts";
import {missingDisks, requiredDisks} from "./disk-marker.mts";

const field = (label: string, value: string) => (
{
	name: `<b>${label}</b>: ${value}`,
});

const INVENTORY =
{
	name: "💾 External Hard Drives",
	children: [
		{
			name: "Instructions",
			children: [
				{
					name: "Commands to run first",
				},
			],
		},
		{
			name: "Inventory",
			children: [
				{
					name: "Alpha",
					children: [field("Percent Full", "99%"), field("Last Synced", "2026-07-24")],
				},
				{
					name: "Bravo (formerly Extreme SSD) (green hole)",
					children: [field("Last Synced", "2026-10-22")],
				},
				{
					name: "Charlie",
					children: [field("Last Synced", "2026-06-01")],
				},
				{
					name: "Delta",
					children: [
						{
							name: "Deduplication: None",
						},
					],
				},
			],
		},
	],
};

test("parseInventory names each drive by its volume name and reads its Last Synced date", () =>
{
	assert.deepStrictEqual(parseInventory(INVENTORY), [
		{
			name: "Alpha",
			lastSynced: "2026-07-24",
		},
		{
			name: "Bravo",
			lastSynced: "2026-10-22",
		},
		{
			name: "Charlie",
			lastSynced: "2026-06-01",
		},
		{
			name: "Delta",
			lastSynced: null,
		},
	]);
});

test("parseGatewayMac and parseOnAcPower read arp and pmset output", () =>
{
	assert.strictEqual(
		parseGatewayMac("? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n"),
		"aa:bb:cc:dd:ee:ff",
	);
	assert.strictEqual(parseGatewayMac("? (172.20.10.1) at (incomplete) on en0 ifscope [ethernet]\n"), null);
	assert.strictEqual(parseOnAcPower("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged\n"), true);
	assert.strictEqual(
		parseOnAcPower("Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging\n"),
		false,
	);
});

test("checkDisks at home suggests the most overdue unplugged drives for the free slots and the NAS", () =>
{
	const result = checkDisks(
		{
			inventory: parseInventory(INVENTORY),
			volumes: [
				"Macintosh HD",
				"com.apple.TimeMachine.localsnapshots",
				".timemachine",
				"bravo",
				"Public",
				"Stray",
			],
			nasMounted: false,
			gatewayMac: "AA:BB:CC:DD:EE:FF",
			onAcPower: true,
			homeGatewayMacs: ["aa:bb:cc:dd:ee:ff"],
		},
	);
	assert.deepStrictEqual(
		result,
		{
			home:
			{
				atHome: true,
				gatewayMac: "aa:bb:cc:dd:ee:ff",
				onAcPower: true,
				reason: "gateway is a home router and the Mac is on AC power",
			},
			maxDisks: 2,
			mounted: [
				{
					name: "Bravo",
					lastSynced: "2026-10-22",
				},
			],
			unknownVolumes: ["Stray"],
			nasMounted: false,
			available: ["Bravo"],
			suggest: [
				{
					name: "Charlie",
					lastSynced: "2026-06-01",
				},
			],
			askMountNas: true,
			undated: ["Delta"],
		},
	);
});

test("checkDisks away from home suggests nothing and never asks for the NAS", () =>
{
	const result = checkDisks(
		{
			inventory: parseInventory(INVENTORY),
			volumes: [],
			nasMounted: false,
			gatewayMac: "11:22:33:44:55:66",
			onAcPower: true,
			homeGatewayMacs: ["aa:bb:cc:dd:ee:ff"],
		},
	);
	assert.deepStrictEqual(
		{
			home: result.home,
			suggest: result.suggest,
			askMountNas: result.askMountNas,
			available: result.available,
		},
		{
			home:
			{
				atHome: false,
				gatewayMac: "11:22:33:44:55:66",
				onAcPower: true,
				reason: "gateway 11:22:33:44:55:66 is not a home router (tethered or away)",
			},
			suggest: [],
			askMountNas: false,
			available: [],
		},
	);
});

test("checkDisks at home with both slots full and the NAS mounted asks for nothing", () =>
{
	const result = checkDisks(
		{
			inventory: parseInventory(INVENTORY),
			volumes: ["Alpha", "Charlie"],
			nasMounted: true,
			gatewayMac: "aa:bb:cc:dd:ee:ff",
			onAcPower: true,
			homeGatewayMacs: ["aa:bb:cc:dd:ee:ff"],
		},
	);
	assert.deepStrictEqual(
		{
			available: result.available,
			suggest: result.suggest,
			askMountNas: result.askMountNas,
		},
		{
			available: ["Alpha", "Charlie", "NAS"],
			suggest: [],
			askMountNas: false,
		},
	);
});

test("checkDisks is not at home on battery or with no home router configured", () =>
{
	const base =
	{
		inventory: [],
		volumes: [],
		nasMounted: false,
		gatewayMac: "aa:bb:cc:dd:ee:ff",
	};
	assert.deepStrictEqual(
		[
			checkDisks(
				{
					...base,
					onAcPower: false,
					homeGatewayMacs: ["aa:bb:cc:dd:ee:ff"],
				},
			).home.reason,
			checkDisks(
				{
					...base,
					onAcPower: true,
					homeGatewayMacs: [],
				},
			).home.reason,
		],
		["on battery power", "no homeGatewayMacs in .llm/gtd/config.json"],
	);
});

test("requiredDisks reads a Disks marker and missingDisks gates on what is available", () =>
{
	const node =
	{
		name: "Sync backups",
		children: [
			{
				name: "Run the sync",
			},
			{
				name: "Disks: Alpha, NAS",
			},
		],
	};
	assert.deepStrictEqual(requiredDisks(node), ["Alpha", "NAS"]);
	assert.deepStrictEqual(
		requiredDisks(
			{
				name: "No marker",
				children: [],
			},
		),
		[],
	);
	assert.deepStrictEqual(missingDisks(["Alpha", "NAS"], new Set(["alpha"])), ["NAS"]);
	assert.deepStrictEqual(missingDisks(["any"], new Set(["NAS"])), ["any"]);
	assert.deepStrictEqual(missingDisks(["any"], new Set(["Alpha"])), []);
});
