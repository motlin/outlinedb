#!/usr/bin/env node
import {setDefaultAutoSelectFamily} from "node:net";
import {execute} from "@oclif/core";
import {join} from "node:path";

process.title = "outlinedb-cli";

// Disable Happy Eyeballs (RFC 8305) auto-selection between IPv4/IPv6.
// Node.js's implementation has a race condition that produces transient
// EBADF errors when the algorithm closes a socket mid-connect.
// See: https://github.com/nodejs/node/issues/54359
setDefaultAutoSelectFamily(false);

const cliPackageDir = join(import.meta.dirname, "..", "packages", "cli");

await execute(
	{
		development: false,
		dir: cliPackageDir,
	},
);
