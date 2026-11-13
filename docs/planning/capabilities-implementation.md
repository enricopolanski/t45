# Capability implementation plan

**Superseded in part on 13 November 2026.** Where the points below conflict with the plan, they win:

- All of this ships on PR #10, without new branches.
- Capability definitions stay in the database, since people will create capabilities from the web UI. Each start refreshes the supplied capabilities and leaves the others alone.
- Schema changes ship as numbered migrations, following T3 Code. There is no longer a clean slate.
- The tool token never enters the VM.
- E2Es come last, once the feature works.
- For now, the Web browser capability's Browserless token is a runner secret (`CAPABILITY_SECRET_BROWSERLESS_TOKEN`) rather than a per-agent encrypted credential, which departs from step 2. That choice is still open.

Move browser use and the existing step, project and workflow MCP servers into `packages/capabilities`. Capabilities are declarative bundles applied generically by the runner. Agent assignments, settings and encrypted write-only credentials live in the database.

Acceptance criteria are in [capabilities.feature](./capabilities.feature). This is an unimplemented plan. Intentional changes are live step/file reads instead of a brief, no general command deduplication, and Browserless Cloud instead of Bright Data. Keep existing authorization, workflow transitions, actual MCP results, explicit draft saving, retained transcripts and chat input-ID deduplication.

## Definitions and ownership

A capability has an ID, description, configuration requirements and any combination of the following optional declarations. There is no capability-specific callback or runner switch.

| Declaration       | Generic runner behavior                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Skills            | Install bundled skills and supporting guidance.                                                                    |
| Files and scripts | Materialize declared files and scripts.                                                                            |
| MCP servers       | Register canonical OpenCode MCP configurations and await readiness before a turn.                                  |
| Dependencies      | Provision pinned requirements through declared package/image inputs and verify availability at execution.          |
| Network rules     | Apply declared egress requirements within the runner's VM security policy.                                         |
| Secrets           | Resolve host-side values and apply destination-restricted placeholder substitution without plaintext in the guest. |
| Agent note        | Install the declared note and have OpenCode read it with the agent's instructions.                                 |

Environment bindings use non-secret settings or secret placeholders. Dependencies and runtime assets have explicit build owners and task prerequisites; agents do not install undeclared requirements. Keep browser-safe metadata separate from Node/runtime code and secret values.

`packages/contracts` owns generic assignment shapes and application models/resources, and never imports capability implementations. `packages/capabilities` imports contracts for resource clients and schemas, and owns definitions, packaged MCP programs, guidance, prompts and runtime assets. The runner owns execution and generic declaration application. The server owns persistence, management permissions, scoped token authorization, application operations and transactions. The web renders capability metadata and existing application views.

Step, project and workflow tools remain MCP servers calling resource RPCs. Preserve their schemas, names and `codemode: false`, so the model sees tools every turn independently of reading a skill. Skills may sit alongside them as guidance. Keep the existing MCP workflow draft card and member Save workflow action; there is no replacement draft-output protocol.

## Read steps and files

Add `workflows.getStep({ stepId })` returning the existing `StepView`, plus `get_step` in the step MCP server. Reuse the builder already behind `workflows.watchStep`. The web and MCP must read the same view, including instructions, fields, declared inputs, substeps, comments and files; do not create an agent-only view.

Authenticate the execution token, enforce its step/project scope, resolve its effective member, and apply the same current access checks as the web. Keep read access separate from actionable-step checks for writes. Keep member `watchStep` behavior intact.

The automation's first message contains only the relevant ticket/step/automation IDs and its automation prompt. Capability instructions tell it to read the step and download files as needed. Remove the preassembled brief, `buildAutomationContext`, the prose/JSON generation in `buildAutomationInput`, and eager file copying used only for that brief. Ordinary member chat attachments keep their current delivery behavior.

Attachment GET accepts the execution bearer token already used by RPCs and uploads. Authorize downloads using the token's scope and effective member's current visibility, including files exposed through declared inputs and the current chat. Arbitrary attachment IDs must not bypass that scope. Preserve token lifetime checks, cookie-authenticated member downloads and existing response headers.

## Write-only credential storage

Separate non-secret configuration from secret rows keyed by agent ID, capability ID and secret name. Store each secret as an encrypted envelope: AES-256-GCM ciphertext, a fresh nonce, authentication tag, a random data key wrapped with RSA-OAEP-SHA256, and an encryption key ID. Bind agent/capability/secret identity as authenticated associated data. Use platform cryptography, not custom primitives.

Provision a durable key pair outside the repository and database. The server gets only the public key and seals new values. Only the runner gets the private key through host secret configuration and decrypts envelopes for execution. Execution requests carry ciphertext envelopes. The private key and decrypted values never enter a VM. Document key provisioning and retention; missing keys fail explicitly rather than saving plaintext or silently generating replacement keys.

Read and mutation responses return non-secret settings and configured/not-configured indicators only, including for creators, admins and managers. They never return plaintext, ciphertext envelopes, reusable secret handles or masked copies of saved values. Write payloads distinguish retain, replace and explicitly remove; omitted credentials preserve saved values when unrelated settings change. Validate required configuration against new values or stored configured state without server-side decryption.

Keep submitted secrets out of logs, errors and agent setup responses. Runner-side substitution is bound to the declared destination/header. Guest files, environment, prompts, arguments and saved disks contain only placeholders. There is no shared provider credential/connection registry. The encryption key pair is deployment infrastructure.

## Browser provider decision

Choose **Browserless Cloud**. It documents direct CDP connections, German residential routing, sticky sessions, automatic CAPTCHA solving and WebSocket bearer-header authentication. This fits Playwright CLI and host-side header substitution without server-side provider session management. Browserbase also offers managed residential proxies, but its documented geographically configured flow creates sessions through its API/SDK; Browserless's direct connection configuration is the simpler fit here. Sources: [header authentication](https://docs.browserless.io/ai-integrations/chrome-devtools-mcp), [residential proxies and Germany targeting](https://docs.browserless.io/baas/bot-detection/proxies), [automatic CAPTCHA handling](https://docs.browserless.io/overview/getting-started/bypass-captchas), [Browserbase proxy sessions](https://docs.browserbase.com/platform/identity/proxies).

Keep Web browser provider-neutral: CDP endpoint, authentication-header secret, Playwright CLI dependency, egress declaration and browsing guidance/note. Browserless is configuration, not a special server branch or capability ID. Select its cloud `/stealth` endpoint with `proxy=residential`, `proxyCountry=de`, `proxySticky=true`, `proxyLocaleMatch=1` and `solveCaptchas=true`. Use a token-free URL and `Authorization: Bearer <placeholder>`, substituted outside the VM. Cloud datacenter egress alone does not meet the intended amazon.de configuration.

Keep the current Playwright CLI interaction. Verify its default-context/page behavior with Browserless: automatic solver events use the provider's existing default context. Do not infer Amazon success from provider documentation or the historical Bright Data report. Real Browserless access, plan/session limits and amazon.de behavior require validation. No self-hosted/local-browser fallback is included.

## No command receipts

v1 has no command receipt ledger, tool-call-ID deduplication or general replay protection for workflow actions. Keep only existing chat input-ID conflict/deduplication behavior. Do not add receipt tables, per-command request IDs or new retry machinery. Repeated tool invocations may repeat effects; ordinary domain invariants and constraints still apply.

The checkout's `CommandLogRepository` and `command_log` are audit history, not receipts, and stay. Correct stale receipt-ledger claims in `todo.md`. If an actual receipt layer exists in the implementation baseline, remove it and its guarantees with the affected commands. Update the old general-deduplication instruction to this explicit v1 decision while retaining authorization and atomicity.

## Mergeable steps

Each numbered step ships complete behavior, its tests and its cleanup. Run `vpr pre-commit`, including mandatory frontend E2Es, at the end of every step and fix all failures before merging. Update dependencies and regenerate the lockfile with `CI= pnpm install --no-frozen-lockfile` in the affected step. Edit `Schema.ts` in place under the existing empty-database policy. No step depends on later work to compile, configure existing agents or run existing tools; do not introduce temporary compatibility shims.

### 1 Extract declarative capabilities and existing MCP servers

Deliver `packages/capabilities` and generic runner application of the declaration sections. Move `apps/server/src/agent-tools/` and shared MCP transport into it, retaining MCP, tool identities and resource results. Package existing step, project and workflow behavior, supporting guidance and built-in behavioral instructions. Keep supplied agent presets as package-owned data loaded generically at initialization.

Replace `appTools` with persisted capability assignments and update save/read resources, schema/repository, editor, built-ins, workflow eligibility and project-chat selection in the same slice. Keep domain access decisions with their consumers. Replace `ChatExecutions` MCP command/bundle assembly with assignment and authorized-context delivery; the runner resolves definitions. Remove server runtime build entries, source glob/read and superseded test/build dependencies. No browser definition or PR #10 browser-specific fields are carried into this baseline. At this step, secret declarations can consume trusted execution context; accepting stored per-agent credentials ships in step 2.

Locations: new package; Agent/Agents/Runner contracts; server schema, agent repository, initialization, chat execution and domain consumers; runner; editor; workspace and task graph.

Verification and exit: frontend E2Es cover agent capability selection, actual step/project MCP results and the unchanged MCP draft card/save. Extend the existing contract-level `FakeRunner.testkit.ts` into a test-only E2E runner harness as needed; current browser fixtures do not run agents. Have it execute packaged MCP programs against real resource APIs and emit canonical OpenCode messages, without mocking the DOM or replacing workflow operations. Keep test controls out of product routes. Check cold, warm and changed-package builds with cached dependencies, including task ordering/artifact ownership. Full pre-commit and E2Es pass without provider credentials.

### 2 Add write-only configuration and encrypted per-agent credentials

Deliver metadata-driven settings/secret fields, separate write/read DTOs, encrypted-envelope persistence, host-side sealing, runner decryption and destination-limited substitution. Managers can enter/replace a value and retain it during unrelated edits; nobody can reveal it through agent APIs. Complete the generic declaration path and operational key provisioning, without a provider-specific server field.

Locations: capability metadata/validation; contracts' save payloads/safe views; schema/repositories; generic secret services and host configuration; runner; editor; operational setup and E2E harness.

Verification and exit: an E2E-only declarative capability fixture with a required secret exercises missing configuration, save, manager reopen, replacement, unrelated edits and separate agents. Assert responses expose no credential and database rows contain only encrypted envelopes. The host harness resolves the right assignment with the private key; errors must not echo it. Observe an authenticated request after placeholder substitution and inspect a real VM/saved disk for a known test secret's absence. Do not add tests that just retest cryptographic library round trips. Verify documented provisioning in a disposable environment. Full pre-commit and E2Es pass without a paid browser account. Steps 1 and 2 can merge independently of the browser rebuild.

### 3 Rebuild PR 10 as the Web browser capability

Rebuild PR #10's useful content on steps 1 and 2. Do not merge it as written or cherry-pick the old browser-specific architecture. Add the declarative Web browser bundle, Playwright CLI dependency, network/secret declarations and browser note. Configure Browserless Cloud through the generic editor with each agent's credential. Keep Chromium out of the VM image. Supply a web browsing agent preset with this capability; it is what Playwright CLI in the image is for. Supplied agents can't be edited, so its token comes from the runner for now (see the note at the top). Retain useful unrelated runner fixes, including provider-key substitution in `x-api-key`, as runner changes.

Locations: browser definition/assets, dependency/image inputs, examples/development instructions and browser checks. There is no `hasWebBrowser`, `has_web_browser`, global `WEB_BROWSER_URL`, browser-specific execution-request field or Browserless branch in server application code. Existing network modes retain their behavior; the capability declares its browser rule.

Verification and exit: frontend E2Es cover browser configuration, write-only credentials, separate assignments and removal before the next execution through the test runner/endpoint. Verify dependency/image artifact ownership and run full pre-commit. Separately run real VM/CDP checks against Browserless Cloud with German residential routing and an amazon.de price check, checking browser-only/open networking, page reads and absence of credentials from messages/disk. If a Browserless account/token is unavailable, mark external acceptance incomplete rather than claiming it passed. Automated gates do not require a paid provider account.

### 4 Read steps through resources and remove the brief

Add `workflows.getStep`, its authorized handler/service operation and the MCP `get_step` tool, sharing the web StepView builder. Add execution-token file downloads with scoped visibility. Change automation startup to IDs and its prompt only; remove briefing text, serialization and eager brief-file delivery together. Update the capability note/optional skill to explain reads/downloads. Correct receipt-ledger claims and remove any actual command-deduplication layer found in the baseline, retaining audit history and chat input-ID deduplication.

Locations: workflow resources/handlers/service, attachment GET/authentication/access, packaged step MCP/notes, automation input construction, affected fixtures/E2Es and obsolete rule/planning references. No alternate agent view, brief fallback or replacement workflow draft protocol is introduced.

Verification and exit: frontend E2Es observe IDs/prompt-only startup, invoke the packaged MCP through the harness and compare its StepView with the web's view for the same effective user, including fresh data after an edit. Download visible own-step/input files with the live execution token and refuse an unrelated private file. Verify reads separately from write refusals, actual operation results, step state after execution and retained transcripts. Keep chat input-ID deduplication coverage; do not assert command-level deduplication. Full pre-commit and mandatory E2Es pass before merging.

## Scenario coverage

| Scenario                                                 | Mergeable step and verification                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Create an agent with a configured capability             | Steps 1-2 verify generic forms/storage; step 3 verifies browser configuration and a safe reopened view. |
| Required configuration is missing                        | Step 2 covers required settings/secrets; step 3 covers the browser editor.                              |
| Update settings without replacing a credential           | Step 2 E2E checks retention and safe responses.                                                         |
| Replace a credential                                     | Step 2 E2E observes the replacement at the next host-side execution.                                    |
| Use the agent's credential without exposing it to the VM | Step 2 verifies encryption/resolution/guest absence; step 3 verifies the browser path.                  |
| Remove a capability                                      | Step 1 covers generic removal; step 3 observes browser requirements disappear.                          |
| Expose step operations as MCP tools                      | Step 1 inspects packaged MCP tools/schemas; step 4 adds the read tool.                                  |
| Start with identifiers and read the step                 | Step 4 checks initial input and compares web/MCP StepViews.                                             |
| Download a visible step file                             | Step 4 downloads own-step and declared-input files with the execution token.                            |
| Refuse a private file outside the execution's access     | Step 4 observes a denied download with the same token.                                                  |
| Contribute to a workflow step                            | Steps 1 and 4 verify persisted changes, actual results and a step that stays working.                   |
| Return a workflow refusal                                | Steps 1 and 4 observe the refusal and unchanged state.                                                  |
| Operate on the conversation's project                    | Step 1 covers allowed/refused MCP operations under existing access.                                     |
| Propose a workflow                                       | Step 1 preserves the existing MCP draft card and explicit member save.                                  |
| Submit the same chat input twice                         | Retain existing coverage throughout; step 4 checks this boundary without receipts.                      |
| Browse amazon.de through the cloud provider              | Step 3 real-provider manual check; E2Es separately verify configuration/CDP wiring.                     |

Wait on observable requests, MCP responses, stream events and change feeds. No sleeps, polling, DOM mocks, parser/codec tests or new server tests. Use model tests for business invariants and frontend E2Es as the integration boundary. Keep existing server tests passing as contracts change until meaningful replacement coverage exists. Distinguish real-provider/VM checks from automated or cached results.

## Delivery and scope

Continue on the current branch for planning. Implementation slices target public main before PR #10, then rebuild its content in step 3; this plan does not authorize branch switches, history rewrites, merges or database edits now. Remove superseded code in its replacing slice, not in a final cleanup required to make earlier steps correct.

No shared provider credentials, additional product capabilities, automatic draft saving, local/self-hosted browser fallback, receipt infrastructure or general recovery redesign. Keep `pr10.report.md` as historical evidence. The accepted capability design and provider decision are recorded here.
