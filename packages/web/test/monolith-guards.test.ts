import {describe, expect, it} from "vite-plus/test";
import {addMonolithGuards} from "../src/client/monolith-guards.js";

const BOM = "﻿";
const TIME = '<time data-monolith="true" contenteditable="false" class="explosive monolith-pill">x</time>';
const MENTION = '<mention data-monolith="true" contenteditable="false" class="mention">x</mention>';

describe("addMonolithGuards", () =>
{
	it.each([
		["time", TIME],
		["mention", MENTION],
	])("guards a %s pill by where it sits", (_name, pill) =>
	{
		expect([
			addMonolithGuards(pill),
			addMonolithGuards(`${pill} lead`),
			addMonolithGuards(`trail ${pill}`),
			addMonolithGuards(`mid ${pill} mid`),
		]).toStrictEqual([`${BOM}${pill}${BOM}`, `${BOM}${pill} lead`, `trail ${pill}${BOM}`, `mid ${pill} mid`]);
	});

	it("looks through formatting wrappers and leaves plain text alone", () =>
	{
		expect([
			addMonolithGuards(`<b>${MENTION}</b>`),
			addMonolithGuards("plain"),
			addMonolithGuards(""),
		]).toStrictEqual([`${BOM}<b>${MENTION}</b>${BOM}`, "plain", ""]);
	});
});
