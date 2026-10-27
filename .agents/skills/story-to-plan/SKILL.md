---
name: story-to-plan
description: Use when turning a feature idea into user stories and then an implementation plan: discovery and Gherkin `.feature` formulation, domain modeling and impact analysis, and dependency-ordered planning. Trigger on writing user stories, `.feature` files, Gherkin, impact or gap analysis, requirements-to-code mapping, or "what do we build next" for a feature.
---

# Story to plan

Three phases carry a feature from an idea to an ordered implementation plan:

1. **Discovery & formulation** — interview, then a Gherkin `.feature` file.
2. **Modeling & impact analysis** — derive the domain, then diff it against the code.
3. **Planning** — sequence the delta into shippable slices.

The industry has names for the pieces, and they overlap. BDD's canonical triad is
**Discovery → Formulation → Automation**. **Specification by Example** (Adzic) and **ATDD** are
the umbrella practices. **Example Mapping** (Wynne) is the discovery workshop. **Impact Mapping**
(Adzic) and **Event Storming** (Brandolini, DDD) cover modeling and impact. **User Story
Mapping** (Patton) and vertical slicing cover planning. There is no single canonical name for
exactly this three-phase pairing; cite the pieces.

## Phase 1 — Discovery & formulation

Goal: examples for every behavior, agreed before any modeling.

- Resolve ambiguity first: the why, the actors, and every lifecycle state. Ask **one question
  at a time** — never dump a questionnaire. When the user delegates a decision ("you decide"),
  decide, state the choice in one line, and continue.
- Write one `.feature` file unless asked to split. Behavioral level: actors and outcomes, not
  clicks and pages.
- Header: product context, a decisions block for choices made, and a `Tags:` line (`@next` vs
  `@future`).
- Group scenarios with `Rule:` per capability. One behavior per scenario, each independently
  testable.
- Lifecycles include their reverse states: deactivate ↔ reactivate, revoke/resend invite,
  last-admin protection, permission matrices via `Scenario Outline`.
- Stop when the user confirms the file. A `.feature` is acceptance criteria, not a work plan —
  do not blend implementation notes into it.

## Phase 2 — Modeling & impact analysis

Goal: name the domain, then locate the delta in the codebase.

Modeling:

- Extract entities, states and transitions, commands, invariants, and the permission matrix from
  the scenarios. A section in the plan is enough; add a diagram only if it earns its place.

Impact analysis:

- For every `Rule`: capability needed (data, service operation, endpoint/contract, UI surface,
  permission check) → what exists today → the delta.
- Read the code to answer "what exists". Check the schema, contracts, service modules, and routes; never guess. In this repo the whole database schema is `apps/server/src/persistence/Schema.ts`, edited in place until the first release.
- Record each delta with its location: schema, `apps/server/src/<module>/`, `packages/contracts`, `apps/web/src/...`.
- Traceability: every scenario maps to at least one test or an explicit manual check. Unmapped
  scenarios are either missing work or missing criteria.

Artifact: an implementation plan in the area's planning directory, mirroring any existing
step-doc style (e.g. a `vX-implementation.md`): per rule — current state → change → location →
tests.

## Phase 3 — Planning

Goal: a build order that keeps the feature shippable.

- Sequence by dependency (e.g. domain/roles → invitations → lifecycle → teams → gating). Each
  slice ends with its scenarios passing.
- Number the steps; mark landed work `DONE` as you go; keep `@future` items explicitly deferred.
- Each step lists: deliverable, files touched, tests, and exit criteria (which scenarios turn
  green).
- Re-read the `.feature` at the end: every scenario must be covered by a step or deferred by a
  tag.

## Guardrails

- Prefer additive changes; check the repo's conventions before proposing rewrites.
- The `.feature` stays living: when behavior changes, edit the scenario, not a prose summary.
- Keep artifacts in the planning area; do not scatter scratch files.
- A merged implementation is the real record; close or update the plan when the work lands.
