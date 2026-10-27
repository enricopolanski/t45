import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Persist transformed modules so repeat runs (the ship gate, edit loops) skip
    // re-transforming the whole graph. The cache lives outside the repo because
    // `vp run --cache test` refuses to cache a task that rewrites files it read.
    fsModuleCache: true,
    // One cache per package: `vp run test` runs packages concurrently, and a
    // shared directory lets one run clear it while another is writing (ENOTEMPTY).
    // Every test task runs with its package directory as cwd.
    fsModuleCachePath: `${NodeOS.tmpdir()}/t3-vitest-cache${process.cwd()}`,
    // Reuse each worker's module graph across test files instead of re-importing
    // it per file; the import cost was most of these packages' test time.
    isolate: false,
    exclude: [
      "**/.repos/**",
      "**/.t45/**",
      "**/.t3/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 5_000,
    testTimeout: 5_000,
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "react/no-unstable-nested-components": ["warn", { allowAsProps: true }],
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/no-test-in-loop": "error",
      "t3code/no-unscoped-has": "error",
      "t3code/one-test-api-import": "error",
      "t3code/namespace-node-imports": "error",
      "t3code/require-suppression-reason": "error",
      "typescript/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": "allow-with-description",
        },
      ],
      "eslint/no-restricted-properties": [
        "error",
        {
          object: "Effect",
          property: "catchTag",
          message: "Catch known tags with `Effect.catchTags({ Tag: handler })`, even for one tag.",
        },
      ],
    },
    overrides: [
      {
        files: ["apps/server/src/attachments/AttachmentRepository.ts"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/ChatService.ts", "**/RunnerService.ts"],
                  message:
                    "File rows are written inside the caller's SQLite transaction, so they never reach the chat service or the runner, which wait on locks, jobs and VMs.",
                },
              ],
            },
          ],
        },
      },
      {
        // Every class in web code must be one Tailwind generates: a typo or a class nothing
        // declares ships silently unstyled. JS hooks use data attributes, not class names.
        // Colors come from theme tokens.
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error", "shadcn/no-raw-colors": "error" },
      },
      {
        // components/ui exports own their look. App code picks a variant or size instead
        // of restyling with className; layout classes (width, flex, margin, position) stay
        // allowed because placement belongs to the parent. components/ui is for generic
        // primitives: a look that belongs to one feature stays in that feature's component.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          // A className built at runtime on a ui component is one no-restyle cannot read.
          "shadcn/require-static-classes": "error",
          // Appearance values come from the theme and Tailwind's scales. Layout stays free
          // (placement belongs to the parent); the other entries are values no scale can hold.
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                // Which properties an element animates is per-element behaviour, like layout,
                // not a design value; timing curves and durations still come from the theme.
                "transition",
                // Overlays that follow their frame's corner, which is set at runtime
                // (floating preview) or by the element they decorate (composer outline).
                "rounded-[inherit]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
