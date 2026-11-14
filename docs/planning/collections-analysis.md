# Collections — analysis

Collections give T45 a durable, shared place for data that people and agents can reuse across tasks. An admin defines a collection and its fields; callers look up records before collecting the same information again. The first use is an Amazon listings collection keyed by ASIN.

T45 already has a server database. The missing feature is a collection model, row operations, and access through the application and agent tools. The proposed implementation uses that existing persistence. Collection data belongs to the server and survives individual chats, steps, and agent sandboxes.

This document separates the requested behavior from implementation recommendations and open questions. It is based on the current code and the [navigation analysis](./navigation-analysis.md). No price-checker automation was run, and no agent configuration or application data was changed for this analysis.

## Requested behavior

- Admins have a Collections page where they create a collection with a title and define its fields the same way they define step fields.
- One field is the primary key. Its value identifies a record within that collection, so adding the same ASIN cannot create a second record there.
- People and agents use the same APIs to add and search rows.
- A Collections capability gives an agent access from a step, a chat, or another execution context. Access does not depend on having a workflow step.
- The competitor price checker looks up an ASIN before scraping it, reuses sufficiently recent data, and collects data when the record is missing or too old.

Two decisions are necessary to make the last point work: how an existing row is refreshed, and what “too old” means. An insert-only API and a unique key cannot refresh a stored price by themselves.

## Collection and row model

A collection owns its title, field definitions, and the ID of its primary-key field. A row belongs to one collection and holds values for those fields. The primary-key designation belongs to the collection; ordinary workflow fields do not acquire uniqueness rules.

The core guarantees are small: a collection used for rows has exactly one valid primary-key field; every row has a non-empty key; supplied values fit their field definitions; and the key is unique within its collection. The server enforces these rules for both human and agent writes. The repository and database enforce uniqueness atomically, so correctness does not depend on a caller remembering to search first.

Recommend storing collection definitions and collection rows separately, with each row's values stored together and its key available for an indexed lookup. A uniqueness constraint on collection ID plus key enforces the requested identity. Write a row atomically: the price, pack count, and observation time from one collection of data should become visible together.

Keep server-managed `createdAt` and `updatedAt` as record metadata. The time data was collected is a different fact. For the Amazon collection, an explicit `checkedAt` field records the successful observation; editing a title must not make an old price look freshly checked.

### Reusing step fields

The existing [field model](../../packages/contracts/src/models/Workflow.ts) supports text, number, boolean, date, file, select, and groups, including repeatable groups. It already defines labels, descriptions, defaults, choices, field paths, and value checks. Recommend extracting those shared field definitions and rules into a field model used by both workflows and collections. Step completion, assignments, and workflow inputs remain workflow behavior.

The field editor is currently inside [WorkflowStepEditor](../../apps/web/src/components/workflows/WorkflowStepEditor.tsx), with supporting logic in [workflowLogic](../../apps/web/src/components/workflows/workflowLogic.ts). Row input and display controls exist in [StepFields](../../apps/web/src/components/work/StepFields.tsx). Reuse the relevant controls and field rules; collections should not call workflow operations to store their values.

Two existing details affect the scope of “the same way as step fields”:

- **Files:** attachments currently belong to steps or chats. Collection file fields need collection ownership, download authorization, and retention in the existing attachment system. Merely storing an attachment ID in a row is insufficient: the current [cleanup logic](../../apps/server/src/attachments/AttachmentRepository.ts) recognizes only step and chat ownership.
- **Dates:** the current date field represents `YYYY-MM-DD`, without a time. An hourly freshness rule needs a timestamp. An ISO UTC timestamp in a text field is sufficient for the first collection without changing the shared date field's meaning; a dedicated date-and-time field is a separate product decision.

ASIN needs a text primary key. Recommend starting with a top-level text field as the key; the allowed key types and full field parity are questions below, rather than assumed restrictions.

## Shared APIs and agent access

Expose collection operations through T45's existing RPC API. The web application and MCP tools call the same contracts and server operations, with the same validation, uniqueness rules, and results. Agents need to discover a collection and read its schema before they can supply valid field IDs and values.

| Operation                                         | Purpose                                                    | Status                                                   |
| ------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| List collections and read a collection definition | Find the collection and obtain its fields and primary key. | Necessary for the admin page and agent discovery.        |
| Create a collection and define its fields/key     | Admin setup.                                               | Requested; later schema edits need an agreed policy.     |
| Add a row                                         | Store a new record using the collection's fields.          | Requested.                                               |
| Search rows                                       | Look up an exact primary key and return matching rows.     | Requested; broader search behavior remains to be agreed. |
| Update a row                                      | Refresh data under an existing primary key.                | Recommended addition needed for stale records.           |

Recommend explicit add and update operations: an add with an existing key reports that the row exists; a refresh updates that row. A single insert-or-update operation is an alternative, but its overwrite behavior should be decided before implementation. In either case, a write returns the saved row so callers can distinguish a successful save from an intention to save.

For initial search, recommend exact primary-key lookup plus equality filters on ordinary scalar fields, combined with AND, and paginated results. This covers ASIN lookup and ordinary table filtering. The exact key lookup should return a row or an explicit absence; an authorization or storage failure must not look like “ASIN missing.” Free-text search is an open question.

The Collections capability can follow the existing [capability model](../../packages/contracts/src/models/Capability.ts), with MCP tools that wrap these RPCs. It should declare no required step or project context. Collection ID is a tool argument, so the same capability works in conversations and automations. The price-checker instructions can name the intended collection; there is no need to inject every collection's records into every prompt.

There are two concrete integration changes beyond adding a capability definition:

- [Agent RPC authorization](../../apps/server/src/auth/Authorization.ts) currently accepts execution tokens only for `workflows.*` and `chats.report`. Permit the collection operations intended for agents and enforce the Collections capability on the server. Supplying a tool to the sandbox is not itself an authorization check. Collection-definition management stays admin-only.
- The [MCP RPC adapter](../../packages/capabilities/src/mcp-stdio.ts) currently knows workflow operations and progress reporting. Extend it with the shared collection contracts and package the tool program through the existing [capability build](../../packages/capabilities/scripts/build.ts). The runner already dispatches declarative capabilities; collection-specific runner behavior is unnecessary.

T45's [organization model](../../packages/contracts/src/models/Organization.ts) defines one organization per deployment. Recommend collections shared within that organization, independent of projects. Which members and agents may read or change their rows still needs a product decision; an admin-only setup page does not answer that question.

## First use: Amazon listings

Use one admin-defined collection for the price checker's existing Amazon.de task. ASIN is its primary-key field. Freshness and product acceptance belong to the price checker: the generic collection stores values and timestamps, while the task decides whether they are usable for its current comparison.

The stored record needs enough information to reuse the observation. The current step output alone is not enough: the [navigation audit](./navigation-analysis.md) found that a captured price could be correct while pack-count, dimension, or material evidence was contradictory.

Proposed starting fields, using the existing field types:

| Fields                                   | Type                                  | Why they are needed                                                                                          |
| ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ASIN                                     | Text, primary key                     | Lookup and deduplication of the selected product variant.                                                    |
| Product URL, title/brand                 | Text                                  | Identify the source and display the listing.                                                                 |
| Width, length per roll, pack count       | Number                                | Match the requested variant and calculate unit price. These describe the masking-tape task already analyzed. |
| Material and supporting product evidence | Text                                  | Retain the facts used to assess the listing, including conflicting statements.                               |
| Listing price, currency, availability    | Number for price; text for the others | Reuse the observed offer with its meaning intact.                                                            |
| Marketplace and delivery postcode        | Text                                  | Identify the context of the observation: the current task uses Amazon.de and `10115`.                        |
| `checkedAt`                              | Text containing an ISO UTC timestamp  | Record when the source was successfully checked.                                                             |

These are proposed fields for this collection, not built-in Amazon fields or a schema imposed on other collections. Unit price can be calculated from listing price and pack count. Whether a listing matches a particular source product is a decision of that comparison, not a permanent property of the shared record.

The proposed lookup procedure is:

1. Obtain the candidate ASIN from the existing search or retained candidate list, then look it up before opening its product page.
2. Reuse the row when its observation is recent enough and contains the required evidence for the same selected variant and delivery context. Apply the current product-matching rules to those saved facts. Report the observation time rather than calling the price live.
3. If the row is absent, stale, or lacks the evidence required for reuse, collect the missing/current information using the navigation procedure. Verify the ASIN of the actual selected variant before saving.
4. Add the new record or update the existing one after successful collection. Save the observation's related values and `checkedAt` together, then write the competitor result to the step through the existing workflow API.
5. If collection fails, retain the existing observation and its original `checkedAt`. A 503, timeout, or incomplete extraction does not establish a fresh price. Whether an old price may still be reported is a task-policy question below.

This avoids product-page visits for usable stored records. It does not automatically eliminate Amazon searches: the existing task chooses qualifying organic results, and those searches supply the candidate ASINs. Using collection rows as the candidate list instead would change that selection policy and needs an explicit decision.

The navigation plan also proposes exploring size and pack options. A stored price and pack count must describe the selected variant together. Its fallback identity, URL plus observed options when a selected ASIN is unavailable, cannot automatically become another row in an ASIN-keyed collection. Keep that unresolved identity question visible rather than silently inventing composite keys.

## Implementation impact and order

This is an implementation outline, conditional on the decisions below, rather than approval to change application behavior now.

| Order | Deliverable                        | Main locations and completion check                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Shared fields and collection rules | Extract the reusable parts of `packages/contracts/src/models/Workflow.ts`; add collection/row models. Existing workflow field behavior remains covered, and collection key/value rules have model tests.                                                                                                                                                                                                         |
| 2     | Durable collection operations      | Add collection contracts under `packages/contracts/src/resources/`, repositories and handlers under `apps/server/src/collections/`, and register them in `RpcApi.ts` and `AppRpc.ts`. Use separate repositories for collection definitions and rows. Add the next numbered persistence migration and register it in `Migrations.ts`; never edit a listed migration. Existing rows in other tables are preserved. |
| 3     | Admin collection page              | Add collection routes under `apps/web/src/routes/` and navigation in `components/settings/settingsSections.tsx`. Reuse the field editor and row controls for schema setup, primary-key selection, row entry, and search. Browser checks exercise persisted rows and duplicate-key behavior. Include attachment integration if full field parity is selected.                                                     |
| 4     | Collections capability             | Add the capability and tool program in `packages/capabilities/src/`, update the MCP adapter/build, and extend authorization. Verify the actual packaged tools against the same server operations from test chat and step executions.                                                                                                                                                                             |
| 5     | Price-checker setup                | Define the Amazon collection, select its freshness policy, and update the checker instructions with collection ID, lookup, reuse, and refresh rules. Review the configuration without running the automation.                                                                                                                                                                                                    |

The required work is shared storage, editing/search APIs, and tools. A uniqueness constraint guarantees one stored row per key; it does not by itself coordinate who is currently scraping that key. This proposal makes no guarantee of eliminating concurrent duplicate scraping and does not introduce a scheduling or locking system.

## Validation without running the price checker

Use model tests for collection-owned rules and real frontend E2Es for persistence, authorization, and tool integration. Do not add server tests or parser/codec tests. Use fixed timestamps and observable results; no waits for data to become old.

- Create a collection through the admin UI, define fields and a primary key, add a row, and find it again after reopening the page. Exercise the field behavior actually supported in the agreed first version.
- Verify that another add with the same key cannot create another row, and that the chosen refresh operation changes the existing record. Check persisted results through the real API/UI.
- Verify the agreed access rules for collection definitions and rows. A missing record and a refused request must produce different results.
- Extend the existing [controlled runner fixture](../../e2e/agent-app.ts) to invoke the packaged collection MCP tools against the real test server. It already does this for reporting. Verify that a row written through a tool is visible in the UI, and a human-written row is returned through a tool, from both chat and step contexts. This requires no model provider or Amazon session.
- Review the price-checker instructions against missing, recent, and old stored observations with fixed data. Check the field mapping and refresh instructions without dispatching the automation. This is a configuration review, not evidence that an LLM will always follow the procedure or that scraping costs have been measured.

No production scrape, paid automation run, or live Amazon test is needed for this feature's initial validation. Actual savings and agent adherence remain unmeasured until a separately requested run.

## Questions to resolve

1. **How recent must an Amazon observation be, and may an older price be reported if refresh fails?** Choose an explicit maximum age. Recommend putting that policy in the price-checker instructions/configuration and using `checkedAt`, rather than imposing one expiry policy on every collection. No duration is assumed here.
2. **Should adding an existing key fail, or update that record?** Recommend separate add and update operations, with refresh explicitly using update. A single save operation that inserts or replaces is also possible; the overwrite behavior needs to be agreed.
3. **Who may read and write rows?** Collection definitions are admin-managed. Are rows available to all active members and every agent with the capability, or should access be selected per collection? This determines both API permissions and who needs a row-browsing UI outside admin settings.
4. **Does the first release include every step field type, including files and nested/repeatable groups?** The existing model supports them, so full parity is a reasonable reading of the request. Files require the ownership and retention work described above; the initial price checker itself needs only scalar fields.
5. **Can the primary key initially be a top-level text field?** That covers ASIN. If other key types are needed immediately, identify them so their equality rules can be defined deliberately.
6. **What should “search rows” include beyond exact ASIN lookup?** Recommend scalar equality filters and pagination initially. Confirm whether people also need free-text matching on titles or other fields.
7. **Should cached listings replace Amazon search results as the source of candidates?** Recommend initially keeping the existing organic-result selection and skipping only eligible product-page reads. Searching the collection first for all competitors could save more navigation, but changes how candidates are selected.
8. **How should the checker handle a selected bundle/variant whose own ASIN cannot be verified?** Recommend saving only observations tied to a verified selected ASIN in this collection. This keeps the requested key meaningful without silently collapsing distinct offers.
9. **What field changes should admins be able to make after rows exist?** Labels and descriptions can change without changing record identity. Changing field types, removing populated fields, or changing the primary key needs a stated policy before enabling those edits; no schema-versioning system is assumed.
