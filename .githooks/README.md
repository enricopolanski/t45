# Native Git hooks

`pnpm install` sets `core.hooksPath=.githooks` through the root `prepare` script, so every checkout and linked worktree uses these hooks.

## `post-checkout`

Runs on branch checkouts only (flag `1`); file-only checkouts are left alone.

1. **Clear TypeScript project emit.** Composite packages leave gitignored `dist/` and `*.tsbuildinfo` that can belong to the previous branch while sources follow HEAD, which shows up as phantom type errors until a clean rebuild. The hook deletes all `apps/*/dist` and `packages/*/dist`, plus any `*.tsbuildinfo` outside `node_modules`, `.git` and `.vite-plus`. Deployments build a separate release instead of switching the running checkout.

   This is a workaround. Remove it when TypeScript/tsgo incremental invalidation is reliable ([typescript-go#2666](https://github.com/microsoft/typescript-go/issues/2666), [#4664](https://github.com/microsoft/typescript-go/issues/4664), [#4262](https://github.com/microsoft/typescript-go/issues/4262)).

2. **Install dependencies.** Each branch checkout runs `pnpm install --frozen-lockfile --prefer-offline`, hardlinking from the shared store. pnpm determines whether dependencies need updating and is resolved from the caller's `PATH`. A failed install is reported but does not fail the checkout.

## `pre-commit`

Runs `vpr pre-commit`, the root package script for workspace format/lint checks, typechecking, unused code (knip), then tests. It checks the whole working tree and stops on the first failure without changing files or staging. Vite+ caches successful tasks by default. Run `vpr pre-commit` yourself, or `vpr --no-cache pre-commit` for fresh checks.
