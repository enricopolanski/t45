# Market-analysis browser navigation

Analysis of alpha-product's saved chats from 11–13 November 2026. All run times below are UTC; the development-server log uses Europe/Rome time, one hour ahead.

The navigation prompt can be improved substantially. The most useful changes are to handle the delivery dialog by its visible state, explore product size and pack options, retain a queue of candidates while visiting product pages, distinguish site error responses from a broken browser, and make acceptance depend on explicit evidence. Increasing persistence or simply asking the agent to be more careful would reinforce several problems already visible in these runs.

Two qualifications matter. First, copying prices and calculating unit prices worked: all 120 saved listing rows across eight automation chats matched a captured product-page price, and all 120 per-piece calculations matched that price divided by the recorded piece count, rounded to two decimals. This does not establish that every piece count or product match was correct. Second, the longest run restarted after development-server starts/rebuilds. A navigation prompt cannot restore execution state that the runtime did not retain.

## Evidence and coverage

The source was the main database at `.t45/worktrees/alpha-product/.t45/userdata/statev2.sqlite`, opened read-only. The audit used `chats`, `chat_messages`, `chat_inputs`, `chat_sessions`, `command_log`, the configured agent instructions and files, and the automation prompt. Isolated browser-test instances were excluded. `/tmp/t45-history-dev.log` supplied corroborating evidence for the latest run's restarts.

Of the 34 chats in the database, 13 were price-collection chats with browser activity: eight workflow automations and five conversational price requests. One additional postcode/IP diagnostic, `ff690723`, was useful for the dialog investigation. The interrupted automation `082bb90a` never reached browser navigation, and credential failures, no-tool checks, and unrelated agents were excluded from the navigation comparison. The 13 price-collection chats all used `opencode-go/deepseek-v4-pro`.

The table reports whole-chat elapsed time, not pure browser latency. A browser shell call is a stored `shell`/`bash` tool invocation containing `playwright-cli`; it may contain multiple commands, a sleep, or a help request. Product reads are structured product-extractor results recovered from tool output, including empty results and repeat visits. They are not counts of accepted or unique products. Message ordinals cited later are zero-based `chat_messages.ordinal` values within the root session; more than one tool can share an ordinal. Chat prefixes are unique in this database.

| Chat       | Started UTC  | Mode       | Elapsed, minutes | Browser shell calls | Product reads | Recorded outcome                                          |
| ---------- | ------------ | ---------- | ---------------: | ------------------: | ------------: | --------------------------------------------------------- |
| `43cba32f` | Nov 11 19:14 | Chat       |             7.33 |                  32 |            16 | 15 table rows; certificate/setup detour                   |
| `56179bb5` | Nov 11 19:35 | Automation |             5.55 |                  23 |            15 | 15 saved rows; earlier, looser matching prompt            |
| `b4c7464c` | Nov 11 19:44 | Chat       |             7.26 |                  43 |            16 | 15 table rows                                             |
| `fb082b24` | Nov 11 20:05 | Automation |             6.19 |                  22 |            15 | 15 saved rows; includes gold/washi products               |
| `cbdac11d` | Nov 11 20:11 | Chat       |             6.93 |                  41 |            15 | 15 table rows                                             |
| `b3a6416c` | Nov 12 00:04 | Automation |            12.34 |                  50 |            38 | 15 saved rows; explicit postcode/material rules           |
| `64d4f706` | Nov 12 00:21 | Automation |            15.21 |                 116 |            46 | 15 saved rows; explicit item-count conflict rule          |
| `a8888150` | Nov 12 00:39 | Chat       |             6.50 |                  38 |            26 | 9 table rows; stopped after Amazon 503 responses          |
| `f1fc643d` | Nov 12 11:35 | Automation |            21.00 |                  78 |            22 | 15 saved rows; delivery-dialog detour                     |
| `4a10fa0c` | Nov 12 11:37 | Chat       |            13.80 |                  62 |            20 | 15 table rows; delivery-dialog detour                     |
| `07b1d268` | Nov 13 16:18 | Automation |            23.57 |                  50 |            25 | 15 saved rows; repeated failures reading the step         |
| `d1bbb896` | Nov 13 21:03 | Automation |            14.65 |                  46 |            25 | 15 saved rows; delivery-dialog and search-context detours |
| `705a30b9` | Nov 13 21:19 | Automation |            34.41 |                 122 |            44 | 15 rows saved, then restarted; manually stopped           |

Together these chats contain 723 browser shell calls and 323 structured product reads. This is observational evidence, not a controlled prompt benchmark: prompts, page language, search results, browser setup, and runtime conditions changed. In particular, the early five-to-six-minute runs are not an equivalent-quality baseline for the later, stricter runs.

Historical prompts read through `/work/AGENTS.md` establish three relevant stages. `56179bb5` preferred crepe paper and sought up to three close matches, with different brands where possible. `b3a6416c` explicitly required Germany delivery, excluded washi/rice/gold tape, and selected the first three qualifying organic results. `64d4f706` added the specific instruction to reject disagreements between “Number of items” and the stated roll count. The current agent retains those stricter rules. The audit distinguishes behavior under each version instead of judging every historical run against today's prompt.

## Findings and prompt changes

### 1. The prescribed postcode sequence assumes the wrong dialog state

The current prompt always ends postcode entry with `playwright-cli click "#GLUXConfirmClose >> visible=true"`. That worked in the earlier `b3a6416c` and `64d4f706` runs. In five later price-collection chats, plus the postcode diagnostic, it failed with “does not match any elements.” Follow-up attempts commonly found the same control hidden and the location header inert because a modal was still open. The evidence supports a changed dialog/state assumption, not a universally invalid selector syntax.

In `d1bbb896`, ordinal 5 applied the postcode but failed to close the dialog. Ordinals 6–13 repeatedly inspected results or controls, retried the hidden confirmation button, and tried to reopen the location header. A targeted inspection finally found the visible **Fertig** button in the active modal. After clicking it at ordinal 14, the header read `10115 Berlin`. In `f1fc643d`, ordinals 10–26 included cookie-button guesses and repeated snapshots before clicking the active dialog's **Close** button. The first product extraction began about 186 seconds after the initial browser-open call; the equivalent interval in `64d4f706` was about 39 seconds. Those intervals include ordinary navigation and model time, so they are not measurements of dialog overhead alone.

Replace the unconditional sequence with a state-based instruction: read the current delivery header; if necessary, open the location dialog, fill and apply the postcode, inspect only the active dialog, and click its visible completion control. Observe the resulting header and modal closure before reading listings. An absent confirmation button is a reason to inspect the dialog once, not to retry the same selector or click the background header. Use the current visible control/reference rather than copying the generated `a-autoid-77-announce` ID from these logs.

The prompt also says the postcode lasts for the rest of the chat. That is too broad. In `705a30b9`, reopening the browser at ordinal 115 produced `Standort aktualisieren`; the agent had to set the postcode again. State that it lasts only while the browser context retains it, and recheck after every reopen and on each accepted product page.

### 2. The agent loses the search page and rebuilds its candidate list

In `d1bbb896`, ordinal 34 tried to extract search results while still on product `B0G4CZPN1F`. It returned an empty string. Ordinal 35 then inspected the URL and discovered it was a product page; ordinal 36 navigated back to the search and rebuilt a larger result list. `f1fc643d` also returned to a search and rewrote extraction expressions to recover additional candidates.

The current search helper returns only the first 24 cards, including sponsored cards, and does not expose the page URL, page number, total extracted count, or whether further results were omitted. The agent improvises 48-card or unbounded extractions when three acceptable listings are not found. This combines unnecessary navigation with an unclear stopping condition.

Have the agent retain the search URL and an ordered queue of candidate links and ASINs before leaving the search page. Record each inspected size/pack combination and its acceptance/rejection reason; switching a product option can expose a different offer. Avoid revisiting an already inspected combination, return to search only when that queue is exhausted, and verify the page type before invoking an extractor. Keep the product extraction separate from the search extraction. The queue can live in a small file in the existing workspace; it is useful within an execution but is not a substitute for durable recovery across VM loss.

Give the search a defined coverage budget. A proposed starting point is at most two search pages and twelve candidate offer inspections per requested variant, stopping sooner after three accepted listings. Count each distinct selected size/pack combination toward the inspection budget, including options reached without a page navigation. These numbers are proposed policy, not an experimentally proven optimum. The tradeoff is real: `64d4f706` inspected 18 products for the 38 mm variant across three search pages before filling its three slots. A bounded version might return two defensible listings instead. Report “search budget reached” separately from “no matching product exists.”

### 3. Timeouts, blocked sites, and browser failure need different responses

In `705a30b9`, product `B01N0BHZQN` incurred two consecutive 60-second navigation timeouts at ordinals 110–111. A title/URL read then timed out after 120 seconds, followed by a 30-second `alive` probe. That is about 270 seconds in four failed tool calls before closing and reopening the browser. The same product subsequently loaded after reopening. This is evidence of an unresponsive browser/navigation path; it is not evidence that Amazon presented a CAPTCHA or that the product had no price.

Conversely, `a8888150` had explicit `HTTP status: 503 Service Unavailable` and page title `Tut uns Leid!` at ordinal 39. The agent retried after sleeps of eight and thirty seconds at ordinals 40–41, despite the loaded browse-web skill saying to stop on this evidence. It ultimately reported nine verified listings and the unvisited variants, which was the right final distinction, but it should have stopped requesting pages after the first explicit block.

The preceding sequence was three searches and 26 product visits in about five minutes: eleven product visits for 19 mm, seven for 25 mm, and eight for 30 mm, including one repeat. Three visits immediately before the final successful product extraction returned generic page titles and empty fields. The subsequent ordinary 38 mm search returned the first explicit 503. This describes the request pattern; it does not establish a blocking threshold or prove that the pattern caused the response.

The term “block” above describes the existing skill's conservative stop rule. A 503 and `Tut uns Leid!` do not establish an anti-bot decision: overload, an upstream failure, or automated-traffic restrictions remain possible. HTTP 503 generally indicates temporary unavailability. Preserve the response status, URL, timestamp, relevant headers when available, and a bounded error-page excerpt so future incidents can be diagnosed. Report the observed error and leave its cause unconfirmed unless further evidence establishes it. [HTTP 503 semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/503)

Specify separate outcomes and finite recovery:

- A normal product with missing or contradictory evidence is rejected; continue with the next candidate.
- A wrong page type, unexpected URL, or empty extractor result gets one compact inspection of the current page before any retry. Empty fields alone do not establish that there are no offers.
- A navigation timeout without blocking evidence permits one bounded diagnostic and, if the browser is unresponsive, one reopen. Retain the candidate queue and previously verified evidence; re-establish the delivery postcode. Do not give a simple title read a multi-minute timeout or retry an unchanged action repeatedly.
- An explicit CAPTCHA, robot challenge, 503, or `Tut uns Leid!` ends browsing on that site immediately under the existing skill policy. Keep earlier verified results and report the unsearched portion and observed error. For a 503, retain an unconfirmed cause rather than asserting bot detection. Reopening must not become a way to evade that stop condition.
- Certificate, authentication, and tool-service failures are reported as environment failures. They are not invitations to investigate the browser installation, alter trust settings, or reverse-engineer application APIs during price collection.

The last point comes from actual detours: `43cba32f` spent many calls investigating a certificate error and CLI internals before collecting prices. It is an older environment incident, not proof of a current certificate problem.

### 4. Explicit evidence rules help, but contradictions still slip through

The evolution of the prompt produced useful changes. `b3a6416c` saved `B0B4WK4M68` as 16 rolls even though the captured facts said “Number of items 6.” After the explicit count-conflict instruction appeared, later runs inspected and skipped that product. Earlier `56179bb5` and `fb082b24` also accepted several gold/washi products under the looser matching instructions. Retain the specific material exclusions and count-conflict example; removing them to make browsing faster would lose a real improvement.

The current rules are still applied inconsistently to dimensions. In `d1bbb896`, product extraction ordinal 43 showed `B092D2ZJJF` with a 38 mm title and the bullet `Klebeband 40mm x 50m – Breite: 38mm`. It was nevertheless saved as a qualifying 38 mm listing at ordinal 52. `07b1d268` also saved that ASIN, and `705a30b9` saved the 20-roll `B092D32943` with the same 40/38 mm contradiction. The data does not tell us which dimension is correct; it does show the agent overriding the existing “nothing on the page contradicts” instruction.

Require a short acceptance record before keeping a listing: requested and actual ASIN/URL, delivery postcode, width, length per roll, pack count, material evidence, displayed offer price, and any conflicting evidence. A positive match cannot cancel a contradiction. For example, explicitly instruct that a 38 mm title plus a 40 mm technical bullet is a rejection, just as 16 rolls plus “Number of items 6” is a rejection. Final prose saying “all listings verified” is insufficient evidence of compliance.

There is also an unresolved material example. `d1bbb896` saved tesa CLASSIC `B09HHCQKZF`; its extraction at ordinal 37 included `Material Leinen` and a bullet calling it `Malerkrepp`. The logs establish conflicting page information, not the actual manufacturing material. The prompt should distinguish backing material from adhesive material and require one targeted check or exclusion when they cannot be reconciled. A generic “Material Gummi” field is not by itself proof of a rubber backing when other text explicitly describes a paper carrier and rubber adhesive.

The source product is a 100 °C automotive masking tape, while the current acceptance rules mostly require matching type, material, and dimensions. Accepted tesa 4323 evidence describes 60/80 °C performance and indoor use. `4a10fa0c` explicitly acknowledged that most results did not match the source's coral-orange/100 °C specification. Decide whether the intended comparison is general crepe tape or equivalent performance grade before adding a stronger filter. Tightening that criterion would change the task's meaning, not merely improve navigation.

### 5. Compact extraction is the right approach, but the output limits are inconsistent

The browse-web skill asks for small extractions of about 3,000 characters rather than full shopping-page snapshots. The configured search helper can return 24 long titles; the product helper includes several fact rows and six truncated bullets. In the 13 price-collection chats, 89 browser shell outputs exceeded 3,000 characters, including navigation wrappers and diagnostics. The largest was 16,647 characters from a broad postcode-related `find` call in `4a10fa0c`; `705a30b9` produced a 12,173-character control inspection. These are observed character counts, not token measurements.

The current product helper also returns `JSON.stringify(...)`, so the CLI often delivers a quoted JSON string containing escaped newlines. Piping that output through `head -80` does not meaningfully limit a single long line. Piping commands through `head` or `tail` also masks command failures: several tool results have shell exit code zero while their output contains `### Error`.

Keep the compact DOM-extraction approach, but make limits part of the extractors: bounded candidate batches with an offset/continuation indicator, direct structured return values, and explicit truncation flags. A missing fact in a truncated result means “not yet verified,” not “absent from the page.” Retrieve only the specific missing section once if it affects acceptance. Preserve contradictory size/count/material text even when shortening descriptions. The prompt should discourage full snapshots, broad control dumps, repeated CLI help calls, and assumptions based solely on a shell exit code.

Those extractor changes are implementation work, not effects that prose alone can guarantee. The configured scripts are currently stored in the agent's `files` under `amazon-search.js` and `amazon-product.js`.

### 6. Three listings is being treated as a target worth prolonged searching

Seven completed automation chats saved exactly fifteen rows; the interrupted latest chat also reached fifteen before restarting. With five variants and a maximum of three listings each, the agent repeatedly fills every slot. This pattern alone does not prove it invented results, and the price-copying audit found no such discrepancy. It does show why a hard coverage limit and an explicit “fewer is acceptable” instruction matter: `64d4f706` needed 46 product reads, versus 15 in the earlier, more permissive runs.

State that three is a ceiling, not a quota. Search ranking is a traversal order, not a claim of representativeness or cheapest price. Do not silently optimize for brands, lowest prices, or exact performance grade unless the task calls for that. Preserve the current separation between Amazon-only automation scope and the wider workflow step listing multiple competitors.

### 7. Some apparent navigation problems originate outside navigation

The `705a30b9` transcript contains three starts of the same work from one stored input:

| UTC               | Evidence                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| 21:19:55          | Reports starting the five variants; reaches the fourth variant before interruption               |
| 21:30:45          | Development server becomes ready; ordinal 65 shortly afterward reports starting collection again |
| 21:52:19–21:53:24 | Saves 91 field changes: one group membership write plus six fields for each of fifteen listings  |
| 21:53:29          | Server log records source-change rebuild and interrupted connections                             |
| 21:53:30          | Server becomes ready again                                                                       |
| 21:53:40          | Ordinal 134 reports starting collection again; later opens the first variant's search            |
| 21:54:03          | `workflows.stopStepAutomation` is recorded and the chat becomes interrupted                      |

Its 44 product extractions cover only 28 distinct ASINs. Sixteen were read twice, consistent with replay of work. All 138 stored messages have `committed = 0`, and there is no saved chat disk. The inspected code saves the disk and commits messages at execution completion, reads uncommitted inputs for execution, and starts owed chats on server startup: [ChatExecutions.ts](../../apps/server/src/chats/ChatExecutions.ts), [ChatRepository.ts](../../apps/server/src/chats/ChatRepository.ts), and [ChatService.ts](../../apps/server/src/chats/ChatService.ts). The restart at 21:53:29 is directly recorded; the earlier new start aligns with the 21:30:45 server launch. The earlier shutdown itself is outside this log.

This explains why “Starting…” reappeared after useful work and even after writes. Prompting the agent to remember previous work cannot recover an absent VM disk or provide a transcript that the new execution was not given. Keep runtime replay/recovery as a separate engineering issue. A workspace candidate file improves ordinary navigation and browser reopen recovery within a live VM; it does not solve this lifecycle problem.

`07b1d268` has a different non-browser detour: twelve `step_get_step` calls all returned “The step tool failed.” The agent explored local tool code and application endpoints and posted a literal `test` comment before eventually saving results. That elapsed time should not be attributed to slow shopping pages. The current prompt needs a clear boundary against debugging the application as part of market analysis. The underlying read failure still needs a tool/runtime fix; this audit does not establish that its cause remains present in the current build.

The 91 successful field actions in a normal fifteen-row automation are expected from the current write interface, not evidence of ninety-one browsing retries. The history UI can aggregate them while retaining the individual audit records.

### 8. Bundles are read, but product options are not explored

The agent recognizes bundles when they appear on an opened listing. The final table in `a8888150`, ordinal 43, includes a 16-roll tesa 19 mm listing, a 12-roll tesa 25 mm listing, a three-roll Werkzeyt 25 mm listing, and a two-roll Rusoz 30 mm listing. It reads the pack count and calculates the price per roll.

Across the inspected price-checker transcripts, there is no recorded interaction with a product size selector, pack-size dropdown, or option button. The recorded clicks and JavaScript click calls handle delivery location and cookies. The agent searches separately for each requested width and reads whichever product configuration opens from the result URL. This is a coverage gap: a suitable size or bundle could be available through product options without appearing as a separate search result. The logs do not establish how many such offers were missed.

Inspect the visible size and pack options before discarding a product family whose default configuration differs from the requested variant. Select relevant available combinations within the same inspection budget, then wait for the selected option and offer information to update. Re-extract dimensions, pack count, price, availability, delivery location, and actual URL/ASIN after every selection. Never combine a new pack count with the previous option's price. Deduplicate by the selected child ASIN when available, or by the URL and observed size/pack combination when the URL stays unchanged. Do not explore unrelated sizes or add duplicate rows for the same selected offer.

### 9. Use a coherent shopping sequence with normal browser interactions

The proposed sequence is search, open a visible organic result using its actual link, inspect relevant product options, reveal the necessary specifications, and continue with the retained candidate queue. Scroll or expand a section when it reveals information needed for the decision. A saved result link can be reused after recovery; constructing a canonical `/dp/<ASIN>` URL should not be the only navigation strategy.

Use normal browser clicks and selections on visible, enabled controls. Wait for meaningful state changes, such as modal closure or the selected variant's offer updating. The logs include JavaScript `.click()` calls on dialog controls; these bypass the normal interaction checks that Playwright's locator actions provide. Playwright checks visibility, stability, whether a control receives events, and whether it is enabled before clicking. These checks directly address the hidden-control failures observed here. [Playwright actionability](https://playwright.dev/docs/actionability)

Retain one browser context while collecting from a shop so cookies, postcode, and selections remain consistent, with sequential navigation and the bounded coverage policy. The current [browser capability](../../packages/capabilities/src/browser.ts) configures a German residential Browserless `/stealth` session with locale matching. Browserless documents that this route keeps the same exit IP within a session by default; preserving that context is already supported. Reopening still requires checking the postcode and restoring the navigation queue. [Browserless session behavior](https://docs.browserless.io/baas/bot-detection/proxies)

These are concrete changes to how the agent navigates and verifies results. The logs provide no evidence that arbitrary mouse movements, synthetic typing delays, or random sleeps would resolve the observed 503s. Measure request volume, duplicate visits, recovery attempts, and error frequency after the changes; do not promise that ordinary-looking interactions will prevent automated-traffic filtering or service errors.

## Proposed navigation prompt

The following is a proposed replacement for the navigation procedure, retaining the existing automation-specific write instructions. The search limits and recovery budgets are proposed starting values to evaluate, not changes applied to the configured agent. The visible-dialog instructions can be used with the current CLI; the structured extractor enhancements described above should be implemented and verified separately.

```text
Find up to three verified listings per requested variant. Three is a maximum, not a target you must fill. Use the requested shops; this automation checks amazon.de only. Keep the existing rules for product type, material, dimensions, pack counts, and where results are written.

Before browsing, identify the variants and the evidence each listing must supply. Load browse-web once. Use the supplied scripts in /work. Do not explore the machine, browser installation, credentials, or application internals as part of finding prices.

Start one browser session and navigate sequentially. Open the first search URL directly. Before using its results, confirm delivery to the requested German postcode, default 10115.

If the postcode is not confirmed, open the location dialog, fill the postcode, and apply it. Inspect the active dialog to find its visible completion control, such as Fertig, Done, or Close. Do not assume that #GLUXConfirmClose is visible. Do not retry a hidden control or click the background location header while a modal is open. If a cookie dialog blocks interaction, dismiss that visible dialog first. Confirm that the location modal closes and the delivery header shows the requested postcode. If one targeted recovery does not establish this, report the blocker and stop collecting prices.

Before every extraction, check that the current URL/page is the expected search or product page. Save the search URL and an ordered queue of actual result links and ASINs before visiting product pages. Open visible organic results using their actual links. Skip sponsored cards and clearly unrelated product types. If the product family offers selectable sizes, inspect its relevant options before rejecting it solely because the default size differs. Track inspected size/pack combinations and rejection reasons. Resume from the queue instead of redoing the search after every product.

Inspect no more than two search pages or twelve candidate offers per requested variant, and stop sooner at three accepted listings. Each distinct size/pack combination inspected counts toward that budget, including options selected on the same page. If the budget is reached, report the verified subset and mark the remaining coverage as incomplete. Do not claim the product is unavailable just because the search limit was reached.

On each product page, inspect visible size and pack selectors. Select relevant available options, using normal browser actions on visible, enabled controls, and wait for the selected option and its offer information to update. Scroll or expand the specific section needed to verify the offer. Re-read all evidence after selection; never carry the previous option's price or availability into the newly selected option. Deduplicate selected offers by child ASIN when available, otherwise by URL plus observed size and pack count.

For each selected offer, verify the actual product URL/ASIN, delivery postcode, width, length per roll, roll count, material, availability, and current listing price. Record the short page excerpts supporting those values and any contradictory statements before accepting it. A positive match never overrides a contradiction: reject a 38 mm title with a 40 mm technical description, or a 16-roll title with Number of items 6. Distinguish the backing material from the adhesive. Follow the existing exclusions for washi, rice paper, and gold tape.

If an extraction is incomplete or truncated, read only the relevant missing section once. If required evidence is still missing or conflicting, skip the listing. Never fill gaps from the search price, old rows, memory, or another variant. Derive the price per roll from the displayed listing price and verified roll count; do not substitute a per-metre price. Keep results compact and retain the evidence in the working notes.

Handle failures by what was observed:
- Explicit CAPTCHA, robot challenge, HTTP 503, or Tut uns Leid!: stop browsing that site under the existing policy and report the verified subset plus the unsearched variants. Record the status, URL, timestamp, relevant response headers when available, and a short error-page excerpt. A 503 alone does not prove bot detection; report its cause as unconfirmed. Do not retry, change identity, or reopen to evade the stop condition.
- Wrong page or empty extraction: inspect the current URL, title, and a small relevant section once before deciding whether it is a missing listing, a block, or a navigation failure.
- Navigation timeout with no blocking evidence: make one brief diagnostic. If the browser is unresponsive, permit one close/reopen recovery, restore the postcode, and resume the retained queue. If recovery fails, stop and report it. Do not repeat the same failing navigation or escalate simple diagnostic reads to multi-minute waits.
- Certificate, authentication, or application-tool failure: report the failing operation. Do not reverse-engineer tools, alter browser trust settings, issue guessed API calls, or post test comments.

Preserve the browser context and its cookies, delivery location, and selected options throughout collection. Recheck delivery location after any browser reopen and on each product you accept. Wait for observable page changes rather than adding arbitrary mouse movements, typing delays, or sleeps. Preserve the recorded command result and error text; a zero shell exit code from a pipeline does not establish success. Avoid full snapshots, broad DOM dumps, and repeated help requests. Use the small supplied extractors and targeted inspection of the active dialog or missing fact.

Keep progress reports tied to real milestones: current variant, verified count, blocker, and saving. When collection ends, follow the automation's existing result-writing rules and preserve other competitors' rows. Do not replace shared rows if you cannot read the current group safely. Only say results were saved after successful write confirmations. Finish with one result comment distinguishing verified listings, rejected candidates, exhausted search budgets, and unsearched variants. Close the browser and end the contribution.
```

The existing replacement prompt is ambiguous about preserving earlier Amazon rows when browsing ends partway through a run. Before deploying the bounded-search version, decide how partial collection should affect those rows. This document does not authorize changing that persistence policy. Likewise, whether temperature rating, waterproofing, colour, VAT, or shipping are mandatory comparison dimensions needs a product decision; the current logs support item-price comparisons, not a claim that delivered total costs or performance grades are equivalent.

## Evaluation and implementation order

First change the dialog procedure, product-option exploration, ordinary browser interactions, candidate queue, explicit stop conditions, and contradiction examples. Keep the useful existing material and count checks. Next improve the configured extractors to expose page identity, delivery state, selected product/offer evidence, and bounded output with explicit omissions; capture bounded diagnostics for service errors. Evaluate the proposed coverage budget separately, since it intentionally trades completeness for bounded effort.

Track execution recovery as separate runtime work with the concrete goal that a server restart must not silently replay an in-progress collection and its existing side effects. The mechanism needs a separate design decision; a prompt edit or a file in a lost VM cannot guarantee it. Reproduce the observed restart after saved rows and verify the chosen interruption/resumption behavior before calling that issue fixed. Track failed application tools separately as well, so neither issue distorts the navigation comparison.

Use the logged cases as concrete browser-behavior checks rather than tests that mock a DOM. A representative interactive replay or controlled browser fixture should include both observed postcode dialog variants; an already-correct postcode; reopening with a reset postcode; a search-to-product transition; selectable size and pack options that change the offer; a missing extraction; contradictory dimensions and item counts; a normal navigation timeout; an unresponsive browser; and an explicit 503. Expected outcomes are observable actions and results: no repeat click on the hidden control, no product acceptance before postcode confirmation, no search extraction on a product page, a selected option's updated dimensions/count/price/availability/URL captured together, no duplicate selected offers, no repeated visits without an explicit recovery reason, no accepted conflicting listing, and no request to the site after a confirmed 503 except closing the session. The error report must distinguish the observed 503 from an unproven bot-detection explanation.

For live comparisons, keep the product variants, agent model, browser configuration, acceptance criteria, and server lifecycle fixed. Record time to first verified listing, browser calls, duplicate visits, dialog recovery attempts, pages and option combinations inspected per accepted listing, extraction size, observed service errors/challenges, final coverage, and correctness of retained evidence. Separate model/runtime time from browser-tool duration; do not infer speedup merely from total elapsed time. Preserve the observed baseline that saved listing prices and arithmetic matched the captured pages. A quicker run with weaker product matching is not an improvement.

No live Amazon browsing, configured-agent prompt updates, database mutations, or runtime fixes were performed for this analysis. Historical page output is evidence of what the agent saw at that time; prices and page behavior were not revalidated on Amazon. Official HTTP, Playwright, and Browserless documentation was consulted for the follow-up recommendations. The proposed prompt has not yet been exercised.

## Reproducing an evidence lookup

Resolve a prefix to its full chat ID and inspect the indicated ordinal using a read-only connection. For example, the conflicting 38/40 mm listing in `d1bbb896` is captured at ordinal 43 and written at ordinal 52:

```sql
SELECT id, title, created_at, updated_at, status
FROM chats
WHERE id LIKE 'd1bbb896%';

SELECT chat_id, session_id, ordinal, message_id, json
FROM chat_messages
WHERE chat_id LIKE 'd1bbb896%' AND ordinal IN (43, 52)
ORDER BY ordinal;
```

For a command-only audit, inspect `command_log` by `chat_id`; it identifies successful field actions but does not replace the browser evidence in `chat_messages`. Some CLI outputs are JSON-encoded strings containing JSON, so decode that outer string before inspecting a product record. Avoid copying authentication configuration or complete unrelated transcripts into reports.
