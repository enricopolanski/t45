import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";

import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import compression from "compression";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig, type Connect, type Plugin } from "vite-plus";

import { loadRepoEnv } from "../../scripts/lib/public-config";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const port = Number(process.env.WEB_PORT ?? 5733);
const sourcemapEnv = process.env.WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const isolatedUnitTestFiles = [
  "src/authBootstrap.test.ts",
  // Replaces the atom registry; under isolate:false that mock leaks into later files.
  "src/lib/attachmentUploadQueue.test.ts",
] as const;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    // Reuse each worker's transformed module graph across test files. The suite
    // resets its stores explicitly; process isolation was spending most of CI
    // time re-importing the same React/Effect graph for every file.
    isolate: false,
    fileParallelism: true,
    maxWorkers: "100%",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [...isolatedUnitTestFiles],
    hookTimeout: 5_000,
    testTimeout: 5_000,
  },
} satisfies TestProjectInlineConfiguration;

const isolatedUnitTestProject = {
  extends: true,
  test: {
    name: "unit-isolated",
    isolate: true,
    fileParallelism: true,
    maxWorkers: "100%",
    include: [...isolatedUnitTestFiles],
    hookTimeout: 5_000,
    testTimeout: 5_000,
  },
} satisfies TestProjectInlineConfiguration;

// Browser dev is single-origin: the backend port is proxied through this
// server so the app works from any origin (localhost, LAN, phone).
// PORT is set by scripts/dev.ts.
function resolveDevProxyTarget(backendPort: string | undefined): string | undefined {
  const port = Number(backendPort?.trim());
  return Number.isInteger(port) && port > 0 ? `http://localhost:${port}/` : undefined;
}

const devProxyTarget = resolveDevProxyTarget(process.env.PORT);

// Vite's dev server sends JS uncompressed. Compressing responses reduces
// transfer time when the browser connects over a shared origin (LAN).
// Brotli quality 5 keeps encode time in the hundreds of ms; the default
// (quality 11) would trade the transfer stall for an equally long encode stall.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      // compression() is typed against Express's req/res, which extend the
      // node http objects Connect actually passes — safe to narrow.
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// Vite rejects requests whose Host header isn't localhost, which blocks sharing
// a dev server by name (ngrok, a LAN host alias); those go through the env var.
const allowedHosts = (process.env.DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

export default defineConfig(() => {
  return {
    plugins: [
      devCompressionPlugin(),
      // Route components load as split chunks so settings and admin code stay
      // out of the cold-start payload; the router prefetches them on navigation
      // intent (see getRouter's defaultPreload).
      tanstackRouter({ autoCodeSplitting: true }),
      react(),
      // Types @babel/core via the @types/babel__core devDependency (Babel 7 ships no declarations); removable at v8.
      babel({
        cwd: import.meta.dirname,
        // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
        // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
        // whereas the previous version of the plugin parsed all files with a .ts extension.
        // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [reactCompilerPreset()],
      }),
      tailwindcss(),
    ],
    optimizeDeps: {
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
      ],
    },
    define: {
      "process.env.BUILD_SHA": JSON.stringify(process.env.BUILD_SHA || "development"),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom"],
    },
    server: {
      host: "0.0.0.0",
      port,
      strictPort: true,
      allowedHosts,
      // Transform the whole module graph at server start instead of on the
      // first request. Without this, a cold worktree discovers and transforms
      // modules one import-level at a time while the browser waits — which
      // over a remote origin turns into minutes of waterfall.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            proxy: {
              "/api": { target: devProxyTarget, changeOrigin: true },
            },
          }
        : {}),
    },
    // @tailwindcss/vite only emits a CSS sourcemap when devSourcemap is on; without it
    // rolldown flags the transform as SOURCEMAP_BROKEN on every sourcemapped build.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
    },
    test: {
      // Persist transformed modules outside the repo (see the root config).
      fsModuleCache: true,
      fsModuleCachePath: `${NodeOS.tmpdir()}/t3-vitest-cache${new URL(".", import.meta.url).pathname}`,
      projects: [defineProject(unitTestProject), defineProject(isolatedUnitTestProject)],
    },
  };
});
