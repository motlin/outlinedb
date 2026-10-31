// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from "vite-plus/test";
import {applyEmoji, serverEmoji, storedEmoji} from "../src/client/emoji-apply.js";
import {EMPTY_PREFERENCES} from "../src/client/hooks/use-preferences.js";

beforeEach(() => {
	document.body.className = "is-desktop font-system _theme-dark";
	localStorage.clear();
});

describe("storedEmoji", () => {
	it("is this browser's emoji_options__selected, or system when unset", () => {
		const unset = storedEmoji();
		localStorage.setItem("emoji_options__selected", "noto");
		expect({unset, stored: storedEmoji()}).toStrictEqual({unset: "system", stored: "noto"});
	});
});

describe("applyEmoji", () => {
	it("replaces every emoji-* body class with emoji-<name> and remembers it like upstream", () => {
		document.body.classList.add("emoji-system", "emoji-other");
		applyEmoji("noto");
		expect({
			className: document.body.className,
			stored: localStorage.getItem("emoji_options__selected"),
		}).toStrictEqual({
			className: "is-desktop font-system _theme-dark emoji-noto",
			stored: "noto",
		});
	});
});

describe("serverEmoji", () => {
	it("is the account's emojiSelected once preferences load, else null", () => {
		const loaded = {preferences: {...EMPTY_PREFERENCES, emojiSelected: "noto"}, available: true, error: null};
		expect([
			serverEmoji(loaded),
			serverEmoji({...loaded, preferences: EMPTY_PREFERENCES}),
			serverEmoji({...loaded, available: false}),
			serverEmoji(undefined),
		]).toStrictEqual(["noto", null, null, null]);
	});
});
