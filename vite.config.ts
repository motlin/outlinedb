import {defineConfig} from "vite-plus";

export default defineConfig(
	{
		// Formatting runs through oxfmt-next-line (configured in .oxfmtrc.json), not Vite+'s bundled oxfmt.
		check:
		{
			fmt: false,
		},
		run:
		{
			tasks:
			{
				// Add dependsOn here for code generation that type-aware lint needs.
				check:
				{
					command: "vp check",
				},
				"test:run":
				{
					command: "node node_modules/vitest/dist/cli.js run",
					cache:
					{
						input: [
							{
								auto: true,
							},
							"!node_modules/.vitest-cache/**",
						],
						output: [],
					},
				},
			},
		},
		lint:
		{
			plugins: ["typescript", "unicorn", "oxc", "import", "react", "vitest", "promise", "node", "jsx-a11y"],
			jsPlugins: [
				{
					name: "vite-plus",
					specifier: "vite-plus/oxlint-plugin",
				},
			],
			categories:
			{
				correctness: "error",
				suspicious: "error",
				perf: "error",
			},
			rules:
			{
				"vite-plus/prefer-vite-plus-imports": "error",
				"react/react-in-jsx-scope": "off",
				"no-case-declarations": "error",
				"no-empty": "error",
				"no-fallthrough": "error",
				"no-prototype-builtins": "error",
				"no-regex-spaces": "error",
				"no-unused-vars": [
					"error",
					{
						varsIgnorePattern: "^([A-Z_]|_)",
						argsIgnorePattern: "^_",
						caughtErrorsIgnorePattern: "^_",
					},
				],
				"react-hooks/rules-of-hooks": "error",
				"react/exhaustive-deps": "error",
				"react/capitalized-calls": "error",
				"react/error-boundaries": "error",
				"react/exhaustive-effect-dependencies": "error",
				"react/globals": "error",
				"react/hooks": "error",
				"react/immutability": "error",
				"react/incompatible-library": "error",
				"react/invariant": "error",
				"react/no-deriving-state-in-effects": "error",
				"react/preserve-manual-memoization": "error",
				"react/purity": "error",
				"react/refs": "error",
				"react/rule-suppression": "error",
				"react/set-state-in-effect": "error",
				"react/set-state-in-render": "error",
				"react/static-components": "error",
				"react/syntax": "error",
				"react/todo": "error",
				"react/unsupported-syntax": "error",
				"react/use-memo": "error",
				"react/void-use-memo": "error",
				"react/no-unstable-nested-components": "error",
				"react/jsx-no-constructed-context-values": "error",
				"react/no-object-type-as-default-prop": "error",
				"react/no-direct-mutation-state": "error",
				"react/jsx-key": "error",
				"react/no-array-index-key": "error",
				eqeqeq: ["error", "smart"],
				"react/only-export-components": [
					"warn",
					{
						allowConstantExport: true,
					},
				],
				"react/no-unescaped-entities": "error",
				"react/jsx-no-useless-fragment": "error",
				"vitest/expect-expect": [
					"error",
					{
						assertFunctionNames: ["expect", "expect*"],
					},
				],
				"vitest/valid-expect": [
					"error",
					{
						maxArgs: 2,
					},
				],
				// Stylesheets and the MCP bin entrypoint are imported for their side effects.
				"import/no-unassigned-import": [
					"error",
					{
						allow: ["**/*.css", "**/dist/index.js"],
					},
				],
				// False positives on deps used inside a nested async IIFE; dropping them creates stale closures.
				"react/memo-dependencies": "error",
				"typescript/no-unsafe-type-assertion": "error",
				"typescript/switch-exhaustiveness-check": "error",
				"typescript/return-await": "error",
				"typescript/only-throw-error": "error",
				"typescript/prefer-promise-reject-errors": "error",
				"typescript/no-mixed-enums": "error",
				"typescript/related-getter-setter-pairs": "error",
				// `||` on a primitive also defaults "" and 0, which most of these call sites rely on.
				"typescript/prefer-nullish-coalescing": [
					"error",
					{
						ignorePrimitives: true,
					},
				],
				"typescript/prefer-includes": "error",
				"typescript/prefer-optional-chain": "error",
				"typescript/prefer-readonly": "error",
				"typescript/no-unnecessary-type-assertion": "error",
				"unicorn/prefer-string-replace-all": "error",
				// React 19's useRef<T>(initial) requires its argument, so `useRef<T>(undefined)` must stay.
				"unicorn/no-useless-undefined": [
					"error",
					{
						checkArguments: false,
					},
				],
				// `{...row, key}` inside map is how this codebase updates data without aliasing the caller's objects.
				"oxc/no-map-spread": "off",
				// ~77 hits are deliberately sequential: rate-limited Workflowy writes, ordered moves, retries, and path walks.
				"no-await-in-loop": "off",
				curly: "error",
				"prefer-template": "error",
				"no-implicit-coercion": "error",
				"typescript/array-type": "error",
				"typescript/consistent-type-imports": "error",
				"typescript/consistent-type-exports": "error",
				"typescript/consistent-generic-constructors": "error",
				"typescript/consistent-type-definitions": "error",
				"typescript/dot-notation": "error",
				"typescript/no-inferrable-types": "error",
				"import/consistent-type-specifier-style": "error",
				"import/no-duplicates": "error",
				"unicorn/numeric-separators-style": "error",
				"unicorn/escape-case": "error",
				"unicorn/no-negated-condition": "error",
				"unicorn/explicit-length-check": "error",
				"unicorn/no-lonely-if": "error",
				"unicorn/prefer-type-error": "error",
				"unicorn/prefer-top-level-await": "error",
				"unicorn/prefer-dom-node-remove": "error",
				"unicorn/prefer-modern-dom-apis": "error",
				"unicorn/no-immediate-mutation": "error",
				"unicorn/no-unreadable-array-destructuring": "error",
				"unicorn/no-useless-collection-argument": "error",
				"unicorn/prefer-import-meta-properties": "error",
				"unicorn/prefer-math-trunc": "error",
				"unicorn/prefer-code-point": "error",
				"unicorn/prefer-number-coercion": "error",
				"unicorn/prefer-logical-operator-over-ternary": "error",
				"unicorn/consistent-existence-index-check": "error",
				"unicorn/prefer-response-static-json": "error",
				"unicorn/prefer-spread": "error",
				"unicorn/prefer-string-raw": "error",
				"unicorn/prefer-structured-clone": "error",
				"unicorn/relative-url-style": "error",
				"oxc/branches-sharing-code": "error",
				// Explicit imports from vite-plus/test satisfy this rule and prefer-vite-plus-imports together.
				"vitest/prefer-importing-vitest-globals": "error",
				"vitest/prefer-strict-equal": "error",
				"vitest/prefer-to-be": "error",
				"vitest/prefer-to-have-length": "error",
				"vitest/prefer-each": "error",
				"vitest/prefer-called-once": "error",
				"vitest/prefer-expect-resolves": "error",
				"vitest/prefer-hooks-in-order": "error",
				"vitest/prefer-expect-type-of": "error",
				"eslint/accessor-pairs": "error",
				"eslint/arrow-body-style": "error",
				"eslint/no-useless-assignment": "error",
				"eslint/prefer-const": "error",
				"typescript/require-await": "error",
				"typescript/no-misused-promises": "error",
				"typescript/strict-void-return": "error",
				"typescript/no-confusing-void-expression": [
					"error",
					{
						ignoreArrowShorthand: true,
					},
				],
				"typescript/promise-function-async": "error",
				"typescript/no-deprecated": "error",
				"typescript/no-unsafe-member-access": "error",
				"typescript/no-unsafe-assignment": "error",
				"typescript/no-unsafe-call": "error",
				"typescript/no-unsafe-return": "error",
				"typescript/no-unsafe-argument": "error",
				"typescript/no-dynamic-delete": "error",
				// Target is es2023, so the `v` flag is unavailable; `u` makes regex parsing strict and astral-aware.
				"require-unicode-regexp": "error",
				"typescript/strict-boolean-expressions": [
					"error",
					{
						allowString: true,
						allowNumber: true,
						allowNullableObject: true,
						allowNullableBoolean: true,
						allowNullableString: true,
					},
				],
				"typescript/restrict-plus-operands": [
					"error",
					{
						allowAny: false,
						allowBoolean: false,
						allowNullish: false,
						allowNumberAndString: false,
						allowRegExp: false,
					},
				],
			},
			env:
			{
				builtin: true,
			},
			ignorePatterns: [
				"dist",
				"build",
				"storybook-static",
				".llm/**",
				"vitest.shims.d.ts",
				"packages/web/.storybook/preview.ts",
			],
			overrides: [
				{
					files: ["public/**/*.{ts,tsx}"],
					globals:
					{
						ServiceWorkerGlobalScope: "readonly",
						ExtendableEvent: "readonly",
					},
				},
				{
					files: ["vite.config.ts", "vitest.config.ts"],
					globals:
					{
						process: "readonly",
					},
				},
				{
					files: ["**/*.test.{js,jsx,ts,tsx}", "**/*.spec.{js,jsx,ts,tsx}", "**/setupTests.{js,ts}"],
					globals:
					{
						vi: "readonly",
					},
					env:
					{
						browser: true,
						jest: true,
					},
				},
				{
					files: ["**/*.{js,jsx}"],
					rules:
					{
						"no-undef": "error",
						"no-redeclare": "error",
					},
					env:
					{
						es2020: true,
						browser: true,
						jest: true,
					},
				},
				{
					files: ["**/*.{ts,tsx}"],
					rules:
					{
						"@typescript-eslint/ban-ts-comment": [
							"error",
							{
								minimumDescriptionLength: 10,
							},
						],
						"no-array-constructor": "error",
						"@typescript-eslint/no-dynamic-delete": "error",
						"@typescript-eslint/no-empty-object-type": "error",
						"@typescript-eslint/no-invalid-void-type": "error",
						"@typescript-eslint/no-namespace": "error",
						"@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
						"@typescript-eslint/no-explicit-any": "error",
						"@typescript-eslint/no-non-null-assertion": "error",
						"@typescript-eslint/no-require-imports": "error",
						"@typescript-eslint/no-unsafe-function-type": "error",
						"no-var": "error",
						"@typescript-eslint/prefer-literal-enum-member": "error",
						"@typescript-eslint/unified-signatures": "error",
						"@typescript-eslint/no-misused-promises": "error",
						"@typescript-eslint/require-await": "error",
						"@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
						"@typescript-eslint/only-throw-error": "error",
						"@typescript-eslint/switch-exhaustiveness-check": "error",
						"@typescript-eslint/prefer-nullish-coalescing": "error",
						"@typescript-eslint/restrict-plus-operands": "error",
						"@typescript-eslint/no-mixed-enums": "error",
						"@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
						"@typescript-eslint/consistent-type-exports": "error",
						"@typescript-eslint/prefer-find": "error",
						"@typescript-eslint/prefer-includes": "error",
						"@typescript-eslint/prefer-string-starts-ends-with": "error",
						"@typescript-eslint/prefer-reduce-type-parameter": "error",
						"@typescript-eslint/prefer-return-this-type": "error",
						"@typescript-eslint/related-getter-setter-pairs": "error",
						"@typescript-eslint/non-nullable-type-assertion-style": "error",
						"@typescript-eslint/prefer-promise-reject-errors": "error",
						"@typescript-eslint/prefer-optional-chain": "error",
						"@typescript-eslint/no-unsafe-return": "error",
						"no-promise-executor-return": "error",
						"no-negated-condition": "error",
						"@typescript-eslint/no-confusing-void-expression": "error",
						"@typescript-eslint/promise-function-async": "error",
						"@typescript-eslint/dot-notation": [
							"error",
							{
								allowIndexSignaturePropertyAccess: true,
							},
						],
						"@typescript-eslint/prefer-readonly": "error",
						"@typescript-eslint/no-deprecated": "error",
						"import/no-cycle": "error",
						"import/no-duplicates": "error",
						"@typescript-eslint/no-unsafe-assignment": "error",
						"@typescript-eslint/no-unsafe-member-access": "error",
						"@typescript-eslint/no-unsafe-call": "error",
						"@typescript-eslint/no-unsafe-argument": "error",
						"@typescript-eslint/no-unnecessary-condition": [
							"error",
							{
								allowConstantLoopConditions: true,
							},
						],
						"@typescript-eslint/strict-boolean-expressions": "off", // Opted out: it forces `=== true` noise.
					},
					env:
					{
						es2020: true,
						browser: true,
						jest: true,
					},
				},
				{
					files: ["**/*.stories.@(ts|tsx|js|jsx|mjs|cjs)", "**/*.story.@(ts|tsx|js|jsx|mjs|cjs)"],
					rules:
					{
						"react-hooks/rules-of-hooks": "off",
						"import-x/no-anonymous-default-export": "off",
						"storybook/await-interactions": "error",
						"storybook/context-in-play-function": "error",
						"storybook/default-exports": "error",
						"storybook/hierarchy-separator": "warn",
						"storybook/no-redundant-story-name": "warn",
						"storybook/no-renderer-packages": "error",
						"storybook/prefer-pascal-case": "warn",
						"storybook/story-exports": "error",
						"storybook/use-storybook-expect": "error",
						"storybook/use-storybook-testing-library": "error",
					},
					jsPlugins: ["eslint-plugin-storybook"],
				},
				{
					files: [".storybook/main.@(js|cjs|mjs|ts)"],
					rules:
					{
						"storybook/no-uninstalled-addons": "error",
					},
					jsPlugins: ["eslint-plugin-storybook"],
				},
				{
					files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
					rules:
					{
						"@typescript-eslint/no-explicit-any": "off",
						"@typescript-eslint/no-non-null-assertion": "off",
						"@typescript-eslint/no-unsafe-type-assertion": "off",
						"@typescript-eslint/no-unsafe-assignment": "off",
						"@typescript-eslint/no-unsafe-member-access": "off",
						"@typescript-eslint/no-unsafe-call": "off",
						"@typescript-eslint/no-unsafe-argument": "off",
						"vitest/no-identical-title": "error",
					},
				},
				{
					files: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.mts"],
					rules:
					{
						// Per-test fakes read better next to the assertion that uses them than hoisted to module scope.
						"unicorn/consistent-function-scoping": "off",
					},
				},
				{
					files: ["test/evals/**"],
					rules:
					{
						// LLM responses include optional fields, so evals assert on them only when present.
						"vitest/no-conditional-expect": "off",
					},
				},
				{
					files: ["plugins/**/*.test.mts"],
					rules:
					{
						// These run under node:test; the rule mistakes its `test` import for a Vitest global.
						"vitest/prefer-importing-vitest-globals": "off",
					},
				},
				{
					files: ["bin/**/*.js", "packages/*/bin/**/*.js"],
					// Node entrypoints read process.argv and process.exit.
					env:
					{
						node: true,
					},
				},
				{
					// Restores project settings where the template's **/*.{ts,tsx} override is looser.
					files: ["**/*.{ts,tsx}"],
					rules:
					{
						"typescript/return-await": "error",
						"typescript/dot-notation": "error",
						"typescript/strict-boolean-expressions": [
							"error",
							{
								allowString: true,
								allowNumber: true,
								allowNullableObject: true,
								allowNullableBoolean: true,
								allowNullableString: true,
							},
						],
						"typescript/restrict-plus-operands": [
							"error",
							{
								allowAny: false,
								allowBoolean: false,
								allowNullish: false,
								allowNumberAndString: false,
								allowRegExp: false,
							},
						],
					},
				},
			],
			options:
			{
				typeAware: true,
				typeCheck: true,
			},
		},
	},
);
