---
name: cut-edge-cases
description: Simplification review that hunts code guarding made-up edge cases and cuts it, one verified change at a time. Digs into the code, everything it talks to, and the source of its dependencies to ask of every guard, catch, timeout, re-check and fallback "can this be simpler if we drop the edge case it handles?". Use it whenever the user asks to simplify a module, strip defensive code, review whether a check or feature pays for itself, question "is this guard needed?", "who calls this?", "can this go?", or wants to move a design towards a simpler invariant (e.g. "always a fresh VM"), even if they don't say "edge case".
---

# Cut made-up edge cases

The goal is less code that is just as correct. Every guard costs code, tests, docs and attention; it pays off only when the case it handles can really happen. Most defensive code was written against a case nobody checked: a caller that can't send that input, a dependency that already does the job, a state the design never produces.

The user stays in charge. You find, verify and propose; they decide; you implement one cut at a time.

## The question

Walk the target module and **everything it interacts with**: its callers, the services it calls, the fakes and tests around it, the docs that describe it, and the dependencies underneath. For each guard, catch, timeout, retry, re-check, fallback, nullable return, ordering step or cleanup job, ask:

> Can this be simpler if we drop the edge case it handles?

Then try to break your own answer from two sides, as a skeptic would:

1. **Is the case real?** Look for a realistic way to reach it.
2. **Does anything else lean on this code?** It may do a second job beyond the guard, like a sort that something downstream relies on.

### Usually made up (cut)

- **The caller can't send it.** The only caller already validates or builds the value: schema-decoded ids, generated uuids, slugs restricted to a catalog, records a schema filter already de-duplicates.
- **The check is duplicated.** An outer timeout fires after an inner one already did; a header pre-check sits on top of a streaming byte cap; a failure is mapped to null twice; an error class exists only to be distinguished by a consumer that treats fail and end the same.
- **The state never happens.** A row just read in the same transaction can't be missing (`RETURNING` plus early return); an insert already checked inside the transaction can't conflict; data already stored in order gets re-sorted; a test sets up a state the design never produces.
- **The dependency already does it.** A feature of the library replaces your own machinery, as microsandbox's ephemeral VMs replaced the runner's start-up sweep.
- **The check sits at an internal boundary.** An internal service re-checks its only, trusted caller, when that caller can already do worse through another path.
- **The fake behaviour is unused.** Test fakes model behaviour that no test exercises.

### Usually real (keep)

- **Agent- or user-controlled input:** sizes, file contents, session graphs (a cycle guard on agent data), files the agent can delete or replace, links planted inside a sandbox.
- **Races with real user actions:** downloading while deleting, a stop racing an answer.
- **Security boundaries.** Even when the argument for cutting is strong, present it and let the user decide (see below).

A real case is not a reason to add code. If you spot an actual bug, write it down; don't fix it unasked.

## Verify before proposing

A proposal is only as good as its evidence. Don't argue from how a dependency "probably" behaves.

- **Read the dependency's source.** Check `.repos/` for vendored submodules first: `git submodule update --init --depth 1 .repos/<name>` fetches the pinned version. Otherwise read the package's types and dist under `node_modules/.pnpm/<pkg>@<version>/`. Make sure the version matches the one in use.
- **Run it for real** when the claim is about runtime behaviour, and when it's cheap and bounded. For example: create a VM from a tiny probe script, SIGKILL the creator, and check what's left, with a control run alongside. Put probes in the job's tmp dir, clean up what they create, and never touch the user's existing resources.
- **Grep every caller, fake route and doc mention** before saying "nothing else uses this".
- If you can't verify a claim, say so in one line and offer how it could be verified. Don't guess.

## Record as you go

Don't hold findings in memory. Write each candidate to `docs/planning/simplification-review.md` as you find it:

```markdown
**#12** `path/to/File.ts:172`: what the code is, which handles <the edge case> (~N lines).

- Why it can go: the evidence, naming the caller, schema or dependency source that rules the case out.
- Change: exactly what goes, including tests, fakes and doc sentences.
```

- **Labels:** use stable bold `**#N**` labels, not Markdown ordered lists. The formatter renumbers lists, and the numbers must stay fixed while you work through them.
- **Index:** keep an index at the top that groups the numbers by theme.
- **Done or decided entries:** remove them from the doc entirely, with no "done" markers. Remove a section once it is empty.
- **Deferred items:** real bugs found along the way, and concerns to revisit later (a security check the user chose to cut), go to `docs/planning/cleanup.md` as one short sentence each.

## Propose one at a time

When the user says "next", pick one entry, or a group that is really the same change, and propose it in a few terse sentences:

- What goes, and why the case can't happen, citing the evidence in one clause.
- **Any behaviour change, stated plainly.** For example: "a cancel in that window now succeeds and the agent answers anyway."
- End with **Go?**

Then stop and wait. Keep it short: the user asks for details when they want them. Recommend; don't survey options.

If a candidate turns out wrong, marginal (it saves about 3 lines but adds a branch), or protects something real, say so and propose dropping it from the doc without changes. Batch several such drops into one proposal.

**Security-relevant checks:** give the strongest argument for cutting, say plainly that it weakens a check, and let the user choose. If they cut it, add a one-sentence review note to `cleanup.md`.

## Implement

On approval:

1. **Make the cut.** Remove what the guard alone needed: imports, constants, error classes, union members, test helpers, now-unused destructured variables, fake routes, and the tests that existed only for the guard. Rename tests whose titles promised the removed behaviour.
2. **Narrow the types** that the removed case widened, such as `| null` or a status union.
3. **Fix the docs.** Rewrite any `docs/internals` sentence that described the removed behaviour; don't append. Keep the wording true, not merely shorter.
4. **Format and check:** run `vp fmt <changed files>`, then `vp run pre-commit` from the repo root. That check, or focused `vp test run <files>`, is the only verification. Never test in a browser.
5. **Clean up the doc:** remove the entry and its index numbers from the review doc.
6. **Report in two or three lines:** what changed, that pre-commit passes, and what left the doc.

Don't widen the scope while implementing. A new idea becomes a new entry, not part of this change.

## Pitfalls seen before

- **Lint:** the Effect lint `preferSchemaOverJson` rejects `JSON.stringify`, so use `Schema.encodeSync(Schema.fromJsonString(...))`. An `Effect.gen` with a single `yield*` gets flagged, so inline it.
- **knip:** after deleting a route or export, regenerate generated files (for example `vp build` for `routeTree.gen.ts`), or knip fails on stale references.
- **Hidden dependents:** a guard can carry a second job. readTree's parent-first walk looked like a pure filter, but session import relied on its order.
