#!/usr/bin/env node
import {execute} from "@oclif/core";

process.title = "outlinedb-cli";

await execute({development: false, dir: import.meta.url});
