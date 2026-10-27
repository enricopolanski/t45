# Models and resources

A proposal to split `packages/contracts` into `models/` (what our entities are and the rules they obey) and `resources/` (what goes over the wire, and the requests that get it), and to make the server and the web both build on those two directories. The code blocks are sketches against this repo's Effect version; what's built so far is under Status.

## Status

The layout is done. `packages/contracts` exports only `./models/*` and `./resources/*`, with no barrel, and the runner, server and web import each name from its subpath.

- Models: `primitives`, `Agent`, `Attachment`, `Chat`, `ComposerContext`, `Notification`, `Organization`, `ScheduledTask`, `Skill`, `User`, `Workflow` and `WorkflowItem`. Each model's `Refused` carries its own message, and the web shows `error.message` (`describeFailure` in `apps/web/src/rpc/failures.ts`).
- Resources: [`RpcApi.ts`](../../packages/contracts/src/resources/RpcApi.ts) merges `Skills`, `Agents`, `Users`, `Organization`, `Chats`, `ScheduledTasks`, `Runner`, `Workflows`, `WorkflowItems`, `WorkflowSteps`, `MyWork` and `Notifications`, served as RPC over plain HTTP at `POST /api/rpc` with streams sent as ndjson (`apps/server/src/AppRpc.ts`); each request is authenticated by its own session cookie, and the web calls it with `api(tag, input)` from `apps/web/src/rpc/api.ts`. There is no socket, and the server keeps no `HttpApi`.
- Beside the group: `Session.ts` (`AuthSessionId`, `AuthSessionState` and the raw cookie routes' `AuthFailure` body), `AgentTools.ts` (what step agents and the drafting agent exchange with T45) and `RunnerVms.ts` (the runner's `RunnerHttpApi`, the one `HttpApi` left).
- Open: see the `packages/contracts` and `SkillEditor.tsx` entries in `cleanup.md` (tests for schema checks; whether `SaveSkillRequest.files` is a list the server turns into the record).

## The take

The split is right, and it fixes the actual problem: today there is no entity layer at all. `packages/contracts` holds only wire shapes, so the server invents its own hand-typed row shapes for storage and its own error vocabulary for refusals, and the web re-implements rules it cannot import. Models give each entity one definition and one home for its rules; resources become pure projections and request lists built from models. The goal is that `ls models/` answers "what are our entities", `ls resources/` answers "what can a client ask for", and a rule exists exactly once.

Three places where I'd diverge from the scanner or from the sketch. First, repositories are server code: they need SQL, so a model does not ship a repository; instead each model has exactly one repository on the server whose methods take and return the model itself, so the model is also the storage shape. Second, chats get almost no model of their own: T45 stores and sends OpenCode's sessions, messages and questions as they are, so `models/Chat.ts` holds only T45's chat row, its inputs, and the metadata T45 writes into OpenCode messages; the rest stays imported from `@opencode/*`. Third, take the scanner's conventions, not its runtime: no effect-app, no `TaggedRequestFor` codegen, no generic `Model.makeRepo`, no machines, no `DBContext` facades, no separate `core.ts` tier. T3's lifecycles are small enough that a model file with its rules is the whole domain layer.

## Why: what's wrong today

Rules are written twice, and two of them already disagree. `blocksMove` is byte-identical in `apps/server/src/workflows/versionMove.ts:225` and `apps/web/src/components/workflows/workflowLogic.ts:272`. The web's `missingFields` (`components/work/workLogic.ts:237`, "mirroring the server's check") re-implements the `step_incomplete` gate in `WorkflowItemService.ts:960-973`. The editor's `draftProblem` and the server's `structureProblem` (`workflows/structure.ts`) validate the same draft with different code and different outcomes. The web disables "remove admin" when `detail.adminUserIds.length === 1` (`WorkflowPeople.tsx:42`), while the server refuses when no other _active_ admin remains (`WorkflowDefinitionService.ts:353-356`), so with one active and one deactivated admin the button is enabled and the request fails; the server itself has three separate last-admin checks (`Organization.requireNotLastAdmin`, workflow `last_admin`, `MemberDeactivation`'s `last_workflow_admin`).

The remaining domains still have competing storage and wire shapes. Storage uses hand-typed rows (`TeamRecord`, `WorkflowRecord`, `ItemRecord`, `StepRecord`, `NotificationRow`, `ChatRow`, `InputRow`), the wire uses `WorkflowItem` and `WorkflowItemStep`, and many ids are still `TrimmedNonEmptyString`, so a team id passes where a user id is expected.

Refusals are declared three times. Each server domain declares its own `Schema.TaggedError` reason unions (`OrgForbiddenError`, `WorkflowRequestInvalidError`, `AgentRequestInvalidError`), `serverHttp.ts` re-declares all of them as one 43-literal `ServerRequestInvalidReason` plus forbidden, not-found and internal unions, every `http.ts` maps one onto the other with a switch, and `apps/web/src/http/client.ts` keys user copy on the merged union with `Partial<Record<…>>`, so a new reason silently gets generic copy.

Files are organized by size, not meaning. `workflow.ts` (937 lines) mixes the definition model, item model, web views, request payloads, the agent brief, the VM step-tool protocol and the drafting MCP name; `serverHttp.ts` (933 lines) holds every HTTP endpoint of four domains plus all errors; 52 of the 216 exported names are `*Input`/`*Request`/`*Result` wrappers used by one endpoint; `index.ts` re-exports everything, so every consumer depends on everything.

There are two client transports with two naming schemes: `WS_METHODS` string constants and `RpcGroup` for chats, scheduled tasks and config; `HttpApi` groups for auth, org, agents and workflows, wrapped again by promise helpers in `apps/web/src/http/`. HTTP reads are fetched once per page, so the "several browsers" surface only holds for the RPC half.

## Definitions

- **Model**: one entity or value object: its branded id, its full shape (a superset of every view of it), and its rules. Pure: no services, no IO.
- **Rule**: what a model obeys. A rule about one value is a check on the model's schema (Skill's name pattern, file paths), so a value that breaks it fails to decode. A rule that depends on the current state is a pure function in the model file that returns a refusal reason or `null`; a transition returns the entity's next value.
- **Refusal**: the domain declining a well-formed request because of the current state (`docs/rules/errors.md`), as a reason from a `const` list carried by the model's one `Refused` error. A decode failure or an infra error is not a refusal.
- **Repository**: the server's storage for one model: a `Context.Service` whose methods take and return the model. No authorization. Its failures are storage failures, decode issues, and the refusals of rules about the stored collection that it enforces itself (Skill's `name_taken` from `save`); how it enforces them is its own business.
- **View**: a wire shape for one consumer, built from model fields (`Struct.pick`) plus derived fields. When the model itself goes over the wire, there is no view.
- **Request**: one RPC (or HTTP endpoint for bytes): a tag, a payload, a success view, the refusals it can fail with.
- **Resource**: one file that groups the views and requests of one collection (`Users`, `Workflows`); the transport contract between a provider and its consumers.
- **Service**: the server's use cases that span several models or are shared with other callers (MCP tools, scheduled tasks), such as `OrganizationService` and `WorkflowItemService`: authorize, load through repositories, apply rules, save, side effects, in one transaction. Not every resource has one: plain CRUD, like skills, has none, and nothing that only implements a resource is called a service.
- **Handler**: the server's implementation of one resource (`agents/Skills.handlers.ts`), Effect's word for what `RpcGroup.toLayer` takes. It calls a service when one exists; for plain CRUD it authorizes, lets the model's schema and rules decide, and calls the repository itself.

## Layout

One package, two directories, explicit subpath exports and no barrel. The package keeps its name.

```
packages/contracts/src/
  models/
    primitives.ts          TrimmedNonEmptyString, NonNegativeInt, makeId; not an entity
    Organization.ts  User.ts  Session.ts  Team.ts
    Agent.ts  Skill.ts
    WorkflowStructure.ts  Workflow.ts  WorkflowItem.ts  StepComment.ts  StepFile.ts  Notification.ts
    Chat.ts  Attachment.ts  ComposerContext.ts
    ScheduledTask.ts       moved untouched; whether it stays is open (cleanup.md)
  resources/
    RpcApi.ts              merges every RPC group; the authorization middleware
    errors.ts              NotFound, NotAMember
    Server.ts  Session.ts  User.ts  Organization.ts  Teams.ts
    Agents.ts  Skills.ts  RunnerStatus.ts
    Workflows.ts  WorkflowItems.ts  WorkflowSteps.ts  MyWork.ts  Notifications.ts
    Chats.ts  ScheduledTasks.ts
    Files.ts               HttpApi: bytes in and out, the Clerk cookie exchange
    Webhooks.ts            HttpApi: public webhook entry
    StepTools.ts           the step tools' MCP server, the brief and the calls read from a step's chat
    WorkflowDrafting.ts    the drafting MCP server and its draft tool
    RunnerVms.ts           RunnerHttpApi: what the server asks of the runner
```

```jsonc
// packages/contracts/package.json
"exports": {
  "./models/*": { "types": "./src/models/*.ts", "import": "./src/models/*.ts" },
  "./resources/*": { "types": "./src/resources/*.ts", "import": "./src/resources/*.ts" }
}
```

Import rules, enforced by a rule in `oxlint-plugin-t3code`: models import only `effect` (Schema, Struct, DateTime and friends, never `effect/rpc`, `effect/http*` or `effect/sql`), `@opencode/schema`, and other models; resources import models and `effect/rpc`/`effect/http-api`; nothing in `packages/contracts` imports an app; the runner imports only `resources/RunnerVms` and the models that config carries. Consumers prefer named imports (`import { Skill, SkillId } from "@t45/contracts/models/Skill"`), aliasing a model's generic exports where they'd collide (`Name as SkillName`), and use a namespace import only where two models meet in one file (`User.Refused` beside `Workflow.Refused`, as in the sketches below). The entity is named after its file (`Skill`). Names state what their doc would (`docs/rules/naming.md`).

The alternative is two packages (`@t45/models`, `@t45/resources`). One is enough: the boundary is the import rule, the lint makes it real, and two packages would double the package.json/tsconfig/test wiring for no extra guarantee.

## Models

The scanner's "a team cannot be left without admins" is, in T3, the organization (its admins) and every workflow (its admins). Here is the organization's, as it would replace `Organization.requireNotLastAdmin`:

```ts
// packages/contracts/src/models/User.ts
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { StringId } from "./primitives.ts";

/** Admins manage the organization, its members and its teams. */
export const Role = Schema.Literals(["admin", "member"]);
export type Role = typeof Role.Type;

/** A `pending` registration has no access until an admin approves it; `deactivated` is reversible. */
export const State = Schema.Literals(["pending", "active", "deactivated"]);
export type State = typeof State.Type;

export const AVATAR_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export const AvatarColor = Schema.Literals(AVATAR_COLORS);

/** How a person appears: their initial on a color, or their image, served by this server. */
export const Avatar = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("initial"), color: AvatarColor }),
  Schema.Struct({ kind: Schema.Literal("image"), url: Schema.String }),
]);

export class User extends Schema.Opaque<User>()(
  Schema.Struct({
    id: StringId,
    email: Schema.String,
    displayName: Schema.NullOr(Schema.String),
    role: Role,
    state: State,
    avatarColor: Schema.NullOr(AvatarColor),
    avatarImageAt: Schema.NullOr(Schema.DateTimeUtc),
    clerkImageUrl: Schema.NullOr(Schema.String),
    profileConfirmedAt: Schema.NullOr(Schema.DateTimeUtc),
    createdAt: Schema.DateTimeUtc,
    updatedAt: Schema.DateTimeUtc,
  }),
) {}

/** Why the organization refuses a change to a member. */
export const REFUSALS = [
  "not_admin",
  "not_pending",
  "not_active",
  "not_deactivated",
  "last_admin",
] as const;
export type Refusal = (typeof REFUSALS)[number];

export class Refused extends Schema.TaggedError<Refused>()("UserRefused", {
  reason: Schema.Literals(REFUSALS),
}) {}

/** What the rules read of a member: the model and every view of it qualify. */
type Standing = Pick<User, "id" | "role" | "state">;

const anotherActiveAdmin = (members: ReadonlyArray<Standing>, target: Standing) =>
  users.some(
    (other) => other.id !== target.id && other.role === "admin" && other.state === "active",
  );

/** Only active admins manage users. */
export const manageRefusal = (actor: Standing): Refusal | null =>
  actor.state === "active" && actor.role === "admin" ? null : "not_admin";

/** The organization always keeps an active admin. */
export const deactivationRefusal = (
  members: ReadonlyArray<Standing>,
  target: Standing,
): Refusal | null => {
  if (target.state !== "active") return "not_active";
  if (target.role === "admin" && !anotherActiveAdmin(members, target)) return "last_admin";
  return null;
};

export const roleChangeRefusal = (
  members: ReadonlyArray<Standing>,
  target: Standing,
  role: Role,
): Refusal | null => {
  if (target.state !== "active") return "not_active";
  if (target.role === "admin" && role !== "admin" && !anotherActiveAdmin(members, target))
    return "last_admin";
  return null;
};

export const deactivated = (member: User, at: DateTime.Utc): User => ({
  ...member,
  state: "deactivated",
  updatedAt: at,
});
```

The rules for every model follow the same shape:

- A model is the full entity. `User` is a superset of today's `OrgMember`, `MyProfile`, `UserRepository.User` and `DirectoryPerson`; those become views or disappear.
- Where OpenCode already declares the thing, the model builds on OpenCode's own schema and adds only what T45 needs: `Skill` takes `Skill.Name` and `content` from `@opencode/schema/skill`'s `Skill.Info` and adds T45's id, supporting files and timestamps. Plain values stay plain objects: models are `Schema.Opaque`, not `Schema.Class`, so a decoded row or a spread is already the model.
- User IDs and step instance IDs use the shared `StringId` schema. Other specialized IDs retain their domain constraints.
- Rules about one value are schema checks: Skill's `Name` is OpenCode's `Skill.Name` checked for lowercase words joined by hyphens, `Description` is a `TrimmedNonEmptyString` of at most 1024 characters, `files` is a record keyed by `FilePath`, so a path can't repeat. There are no size or count limits on what an entity holds: we add one only when a real problem shows up, and a transport that can't carry a payload is a reason to rethink the transport. Rules that read the current state are guards returning `Refusal | null`, the convention `structureProblem`, `proposalProblem` and `limitRefusal` already use; transitions return the next value. Rules take the narrowest structural input (`Pick<…>`, or a view's own field tree) so the same function runs on the model in a service and on a view in the browser.
- A rule takes everything it decides on as arguments. When it needs other entities (the last-admin rule needs all members), the service loads them; the rule never reaches for them. A rule about a whole collection that the model can't see (no two skills share a name) isn't a model rule: the repository enforces it and raises the model's refusal. Rules over unbounded data (chat messages) don't exist.
- The model owns its refusals: one `const` list, one `Refused` error with a globally unique tag (`"SkillRefused"`, `"UserRefused"`), raised by the services and repositories that touch the model. Authorization refusals (`not_admin`) are refusals like any other; the 400/403/409 split disappears with the transport.
- Limits are model constants (`MAX_AVATAR_BYTES`), and the rules that read them live beside them.
- Timestamps are `Schema.DateTimeUtc`, which RPC and HTTP already encode as ISO strings; `ScheduledTask`'s `DateTimeUtcFromString` fields are the odd ones out.
- Bytes never live in models: avatar images, attachment content and workspace tarballs are read and written by separate repository methods.

## Repositories

```ts
// apps/server/src/org/UserRepository.ts — decodes the shared User model
import * as User from "@t45/contracts/models/User";

/** Rows decode straight into the model; the JSON codec reads the ISO timestamp columns. */
const Row = Schema.toCodecJson(User.User);
const COLUMNS = `id, email, display_name AS "displayName", role, state, avatar_color AS "avatarColor", avatar_image_at AS "avatarImageAt", clerk_image_url AS "clerkImageUrl", profile_confirmed_at AS "profileConfirmedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly all: Effect.Effect<ReadonlyArray<User.User>>;
    readonly get: (id: StringId) => Effect.Effect<Option.Option<User.User>>;
    /** Writes every column; callers run it inside their service's transaction. */
    readonly save: (member: User.User) => Effect.Effect<void>;
    readonly remove: (id: StringId) => Effect.Effect<void>;
    readonly avatarImage: (id: StringId) => Effect.Effect<
      Option.Option<{
        readonly contentType: string;
        readonly content: Uint8Array;
      }>
    >;
  }
>()("t45/org/UserRepository") {}
```

- One repository per model aggregate, named after it, in the domain folder that owns the table (`org/UserRepository.ts`, `org/TeamRepository.ts`, `workflows/WorkflowItemRepository.ts`). Not one per table: a `Team` loads with its memberships, a `WorkflowItem` with its steps and values.
- Methods speak the model. `save(member)` replaces `updateRole`, `setState`, `updateProfile`, `confirmProfile` and `setClerkImage`, because the transition already computed the next value. A query that only the database can answer cheaply (paged chat messages, My work across workflows) is a named read returning a view or model array.
- The row codec is the only storage-specific schema, private to the repository; it adds a column transform only where the database's encoding differs from JSON (0/1 booleans, JSON-in-text columns). `Record`/`Row` interfaces disappear.
- Storage failures are defects (`Effect.orDie`): nothing in a request recovers from a failed write, the transport logs it once and the client shows a generic failure. That removes `OrgStorageError`, `WorkflowStorageError`, `AgentStorageError`, `ServerInternalError`'s `*_operation_failed` reasons and `failServerInternal`. Workers that retry (chat capture) keep their typed failures where they branch on them.
- Server-private rows stay server-private, with no model: `auth_sessions`' token hashes, `chat_attachments`, `workflow_chat_calls` dedup keys, webhook deliveries (gone with scheduled tasks). OpenCode's sessions, messages and questions are stored in OpenCode's own shapes; their "model" is `@opencode/schema`.

## Resources

```ts
// packages/contracts/src/resources/Users.ts — replaces OrgMember, OrgMemberRoleRequest and the members endpoints of serverHttp.ts
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import * as User from "../models/User.ts";
import * as Workflow from "../models/Workflow.ts";
import { NotFound } from "./errors.ts";

/** A member as the members area lists them: no Clerk picture, no profile internals. */
export class UserSummary extends Schema.Opaque<UserSummary>()(
  Schema.Struct({
    ...Struct.pick(User.User.fields, [
      "id",
      "email",
      "displayName",
      "role",
      "state",
      "createdAt",
      "updatedAt",
    ]),
    avatar: User.Avatar,
  }),
) {}

const Target = Schema.Struct({ userId: StringId });
const WithRole = Schema.Struct({ userId: StringId, role: User.Role });
const Refusals = Schema.Union([User.Refused, NotFound]);

export const Users = RpcGroup.make(
  Rpc.make("list", { success: Schema.Array(UserSummary) }),
  Rpc.make("approve", {
    payload: WithRole,
    success: UserSummary,
    error: Refusals,
  }),
  Rpc.make("decline", { payload: Target, error: Refusals }),
  Rpc.make("changeRole", {
    payload: WithRole,
    success: UserSummary,
    error: Refusals,
  }),
  /** Ends their sessions and takes them off every team; a workflow refuses to lose its last active admin. */
  Rpc.make("deactivate", {
    payload: Target,
    success: UserSummary,
    error: Schema.Union([User.Refused, Workflow.Refused, NotFound]),
  }),
  Rpc.make("reactivate", {
    payload: Target,
    success: UserSummary,
    error: Refusals,
  }),
).prefix("users.");
```

```ts
// packages/contracts/src/resources/RpcApi.ts — replaces rpc.ts; WS_METHODS goes away
export const RpcApi = Server.merge(
  Profile,
  Organization,
  Users,
  Teams,
  Agents,
  Skills,
  RunnerStatus,
  Workflows,
  WorkflowItems,
  WorkflowSteps,
  MyWork,
  Notifications,
  Chats,
  Attachments,
  ScheduledTasks,
).middleware(Authorization);
```

- A resource is named for its collection, plural (`Users`, `WorkflowSteps`), and its tags are `<collection>.<verb>` (`users.list`, `workflowSteps.approve`), which is today's `chats.send` style. `apps/web/src/rpc/client.ts` derives its tag types from `RpcApi` instead of `WS_METHODS`.
- Order inside a file: views just before the first request that uses them, then `list*`, `get*`, `find*`, `watch*`, then commands alphabetically.
- `get` returns a non-nullable view and fails `NotFound` when the id doesn't exist; `find` returns `NullOr` when absence is a normal outcome; `list` returns an array; streams start with `watch` (`chats.watchList`, `chats.watch`, today's `subscribe` and `open`); commands are verbs (`approve`, `rename`, `addMember`).
- One slim view per consumer: a page that needs one thing calls a `get`, never a `list` it filters, and a `list` row grows only when every list consumer renders the new field (the scanner's query-shape rule).
- Payloads are inline. A payload or view gets a name only when two requests share it; the 52 `*Input`/`*Request`/`*Result` exports go.
- A view carries the verdicts its page shows (`canManage`, `parts`, `missing`) computed by the model's rules on the server, unless the page needs the verdict before the server answers, in which case the page runs the same rule on the view.
- The error union of a request is the refusals of the models it touches plus `NotFound`. There is no mapping step anywhere.
- The few `HttpApi` resources (`Files`, `Session`, `Webhooks`) annotate statuses on their own endpoints' errors; model `Refused` classes carry none.
- Authorization stays in services, re-read from stored state on every call, because MCP tools and scheduled tasks call services without a transport; resources carry no role annotations.

## Services, handlers and the web

```ts
// apps/server/src/org/Organization.ts — the service applies rules, the repository stores the result
const deactivateMember = (actorId: StringId, userId: StringId) =>
  transactional(
    Effect.gen(function* () {
      const everyone = yield* users.all;
      const actor = yield* requireMember(everyone, actorId);
      const target = yield* requireMember(everyone, userId);
      const refusal = User.manageRefusal(actor) ?? User.deactivationRefusal(everyone, target);
      if (refusal !== null) return yield* new User.Refused({ reason: refusal });
      const next = User.deactivated(target, yield* DateTime.now);
      yield* users.save(next);
      yield* deactivationHook.memberDeactivated(next.id);
      yield* teams.removeFromAll(next.id);
      yield* sessions.revokeAllForUser(next.id);
      return toUserSummary(next);
    }),
  );
```

```ts
// apps/server/src/org/Users.handlers.ts — replaces the members half of org/http.ts and its mapOrgError
export const layer = Users.toLayer(
  Effect.gen(function* () {
    const organization = yield* OrganizationService;
    return Users.of({
      "users.deactivate": ({ userId }) =>
        Effect.gen(function* () {
          const actor = yield* ServerAuthenticatedPrincipal;
          return yield* organization.deactivateMember(actor.userId, userId);
        }),
      // the same three lines for every request
    });
  }),
);
```

```tsx
// apps/web (sketch): the button asks the same rule the server enforces
const refusal = User.deactivationRefusal(members, member);
<Button
  disabled={refusal !== null}
  disabledReason={refusal && new User.Refused({ reason: refusal }).message}
  onClick={() => deactivate({ userId: member.id })}
>
  Deactivate
</Button>;
```

- Server domain folders stay (`org/`, `workflows/`, `chats/`, `agents/`), each holding its repositories, its service and one `<Resource>.handlers.ts` per resource it serves. `api.ts` merges the handler layers, and the raw routes left are attachment bytes, avatars, the session cookie and webhooks.
- A view's builder (`toUserSummary`) lives in the service that serves it; only the schema is shared.
- The web imports models for ids, value types and rules, and resources for views and requests. Each model's `Refused` carries its own copy in a `message` getter, and the web shows `error.message`, so no page keeps a copy map; `describeHttpFailure` and its partial maps are gone.

## Testing

- State rules get plain table-driven tests beside them (`models/User.test.ts`): literal arrays in, a reason or a value out, no layers, no database, no runtime. Most refusal cases in `Organization.test.ts`, `WorkflowItemService.test.ts`, `WorkflowGroups.test.ts` and `WorkflowVersionMove.test.ts` move down here and get cheaper. Schema checks get no tests for now (`cleanup.md` keeps the question), and nothing tests Effect's own APIs.
- Service tests keep the scenarios: one case per refusal proving the service refuses it, plus what only the service does (the transaction, session revocation, the deactivation hook, notifications).
- Each repository gets one round-trip test against an in-memory database: save, load, equal.
- Resources and handlers get no tests of their own: resources are declarations and handlers are one call each; a request is covered by its service test.
- The web stops testing re-implemented rules (`missingFields`, `draftProblem`); it tests only logic that exists only in the web.

## Inventory

### Models

| Model               | Id                    | Tables                                                                      | Rules it owns                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Organization`      | fixed singleton       | `organizations`                                                             | named once by the first admin                                                                                                                                                                                                                                                                                                   |
| `User`              | `StringId`            | `users`                                                                     | admission (approve/decline), role and lifecycle transitions, last active admin, manage permission, profile confirmation, avatar of a member, `MAX_AVATAR_BYTES`                                                                                                                                                                 |
| `Session` (ID only) | `AuthSessionId`       | server-private `auth_sessions`                                              | no shared session inventory model; authentication, expiry and revocation stay in `SessionStore`                                                                                                                                                                                                                                 |
| `Team`              | `TeamId`              | `teams`, `team_memberships`                                                 | unique names, only active members join, leaving on deactivation                                                                                                                                                                                                                                                                 |
| `Agent`             | `AgentId`             | `agents`, `agent_skills`                                                    | unique names, relative file paths (`isRelativeFilePath`), archive/restore, network modes; `Setup` (files, skills, MCP servers) and `AgentModel` (a runner model slug) live here                                                                                                                                                 |
| `Skill`             | `SkillId`             | `skills`                                                                    | name (OpenCode's `Skill.Name`, lowercase words joined by hyphens, at most 64), description (at most 1024), files by portable relative path other than SKILL.md; refusal `name_taken`, raised by the repository                                                                                                                  |
| `WorkflowStructure` | `StepKey`, `FieldKey` | `workflows.draft`, `workflow_versions`                                      | well-formed fields and groups, unique keys (`structureRefusal`), step nodes, draft changes between versions, field value shapes                                                                                                                                                                                                 |
| `Workflow`          | `WorkflowId`, `Slug`  | `workflows`, `workflow_admins`, `workflow_step_people`, `workflow_versions` | last active admin, archive instead of delete, slugs (`toSlug`), people resolution (`stepResolution.ts`), publish blockers                                                                                                                                                                                                       |
| `WorkflowItem`      | `StringId`            | `workflow_items`, `workflow_item_steps`, `workflow_field_values`            | step state transitions (done, approve, reject, send back to an earlier step, block, claim), the completion gate (`missingFields`), parts a person has in a step (`partsIn` in `workflowAccess.ts`), My work sections, move impacts of a publish (`versionMove.ts`), helper selections and proposal checks (`helperProposal.ts`) |
| `StepComment`       | `CommentId`           | `workflow_step_comments`                                                    | comment kinds and authors                                                                                                                                                                                                                                                                                                       |
| `StepFile`          | `FileId`              | `attachments` (`item_id`, `step_key`, `field_key`)                          | `WORKFLOW_ATTACHMENT_MAX_BYTES`, file-field binding                                                                                                                                                                                                                                                                             |
| `Notification`      | `NotificationId`      | `workflow_notifications`                                                    | kinds, who is told of a transition (`fallbacks.ts`, made pure)                                                                                                                                                                                                                                                                  |
| `Chat`              | `ChatId`              | `chats`, `chat_inputs`                                                      | chat status, owned and ownerless chats (a step's agent works in an ownerless one) and the automation id prefixes, input ids and idempotency (same id, other content is a conflict), the metadata T45 writes into OpenCode messages, notes, message state (`live`/`settled`/`lost`), `MESSAGE_MAX_INPUT_CHARS`                   |
| `Attachment`        | `AttachmentId`        | `attachments`, `chat_attachments`, files on disk                            | kinds, MIME types, per-file and per-message limits (`limitRefusal`)                                                                                                                                                                                                                                                             |
| `ComposerContext`   | `ContextId`           | inside chat inputs                                                          | context records riding a message                                                                                                                                                                                                                                                                                                |
| `ScheduledTask`     | `ScheduledTaskId`     | `scheduled_tasks`                                                           | moved untouched; whether it stays is open (cleanup.md)                                                                                                                                                                                                                                                                          |

### Resources

| Resource           | Requests                                                                                                                                            | Consumer                                                     | Transport                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `Server`           | `server.probe`, `server.watchConfig`                                                                                                                | web                                                          | RPC                                                                                                                 |
| `Session`          | session state, sign-in exchange, sign-out                                                                                                           | web sign-in gate                                             | HTTP                                                                                                                |
| `Profile`          | `profile.get`, `profile.confirm`                                                                                                                    | web welcome step                                             | RPC (an active member's); an uploaded avatar goes to `Files` first and `confirm` names it, so no image rides an RPC |
| `Organization`     | `organization.get`, `organization.rename`                                                                                                           | web settings                                                 | RPC                                                                                                                 |
| `Users`            | list, approve, decline, changeRole, deactivate, reactivate                                                                                          | web settings                                                 | RPC                                                                                                                 |
| `Teams`            | list, getWork, create, rename, addMember, removeMember                                                                                              | web                                                          | RPC                                                                                                                 |
| `Agents`           | list, listModels, getSetup, create, update, archive, restore                                                                                        | web                                                          | RPC                                                                                                                 |
| `Skills`           | list, create, update, delete                                                                                                                        | web                                                          | RPC                                                                                                                 |
| `RunnerStatus`     | get                                                                                                                                                 | web (admins)                                                 | RPC                                                                                                                 |
| `Workflows`        | list, listStartable, get, getBoard, getPublishPreview, create, update, saveDraft (with people), publish, addAdmin, removeAdmin, setArchived, delete | web, MCP                                                     | RPC                                                                                                                 |
| `WorkflowItems`    | get, start, cancel, reopen, setDueDate                                                                                                              | web                                                          | RPC                                                                                                                 |
| `WorkflowSteps`    | get, setField, markDone, approve, reject, reassign, sendBack, block, unblock, comment, attachFile, removeFile, callInHelper, stopHelper             | web                                                          | RPC                                                                                                                 |
| `MyWork`           | get                                                                                                                                                 | web                                                          | RPC                                                                                                                 |
| `Notifications`    | list (with the unread count), markRead                                                                                                              | web                                                          | RPC                                                                                                                 |
| `Chats`            | watchList, watch, getHistory, getMessage, create, send, cancel, answer, dismiss, stop, compact, rename, delete                                      | web                                                          | RPC                                                                                                                 |
| `Attachments`      | delete                                                                                                                                              | web                                                          | RPC                                                                                                                 |
| `Files`            | chat attachment upload and download, step file upload and download, avatar upload and image                                                         | web                                                          | HTTP                                                                                                                |
| `Webhooks`         | post, put, patch, get                                                                                                                               | outside callers                                              | HTTP                                                                                                                |
| `StepTools`        | the step tools' MCP server (`STEP_TOOLS_MCP`), the brief, every step tool call                                                                      | the step's agent, `apps/runner/image/step-tools.mjs`, server | the brief as a chat input; calls read back from the chat's messages                                                 |
| `WorkflowDrafting` | the drafting MCP server, its draft tool's input                                                                                                     | `workflow-tools.mjs`, web chat card                          | MCP                                                                                                                 |
| `RunnerVms`        | inventory with health, models, ensureChat, workspace get/put, putChatFile, removeChat                                                               | server                                                       | HTTP                                                                                                                |
| `ScheduledTasks`   | as today                                                                                                                                            | web                                                          | RPC, until removed                                                                                                  |

### Where today's exports go

| Today                                                                                                                                                                                                                                                                 | Goes to                                                                | Note                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `baseSchemas.ts`: `TrimmedString`, `TrimmedNonEmptyString`, `NonNegativeInt`                                                                                                                                                                                          | `models/primitives.ts`                                                 | plus `makeId`                                                                                      |
| `ThreadId`, `AuthSessionId`, `ScheduledTaskId`                                                                                                                                                                                                                        | `models/Chat` as `ChatId`, `resources/Session`, `models/ScheduledTask` | done                                                                                               |
| `MessageId`                                                                                                                                                                                                                                                           | OpenCode's `SessionMessage.ID`                                         | done                                                                                               |
| role and state                                                                                                                                                                                                                                                        | `models/User` as `Role`, `State`                                       |                                                                                                    |
| `AuthSessionState`, `AuthBrowserSessionResult`,                                                                                                                                                                                                                       | `resources/Session`                                                    | no session inventory or selective revocation                                                       |
| `ServerAuthDescriptor`                                                                                                                                                                                                                                                | `resources/Server`                                                     |                                                                                                    |
| `ServerAuthorizationError`                                                                                                                                                                                                                                            | `resources/errors` as `NotAMember`                                     |                                                                                                    |
| `org.ts`: `Organization`                                                                                                                                                                                                                                              | `models/Organization`                                                  |                                                                                                    |
| `AVATAR_COLORS`, `AvatarColor`, `PersonAvatar`, `MAX_AVATAR_BYTES`                                                                                                                                                                                                    | `models/User`                                                          | `avatarOf` (server `org/avatars.ts`) becomes a rule                                                |
| `MyProfile`, `ConfirmProfileRequest`                                                                                                                                                                                                                                  | `resources/Users`                                                      | view picks from `User`                                                                             |
| `OrgMember`                                                                                                                                                                                                                                                           | `resources/Users` as `UserSummary`                                     |                                                                                                    |
| `OrgTeam`                                                                                                                                                                                                                                                             | `models/Team`                                                          | sent as is; no view                                                                                |
| `UpdateOrganizationRequest`, `OrgMemberRoleRequest`, `CreateOrgTeamRequest`, `UpdateOrgTeamRequest`                                                                                                                                                                   | inline payloads                                                        |                                                                                                    |
| `agent.ts`: `Agent`, `AgentFile`, `McpServers`, `AgentSetup`, `AgentModel`                                                                                                                                                                                            | `models/Agent`                                                         |                                                                                                    |
| `Skill`                                                                                                                                                                                                                                                               | `models/Skill`                                                         | done                                                                                               |
| `SaveAgentRequest`, `SaveSkillRequest`, `AgentModels`                                                                                                                                                                                                                 | `resources/Agents`, `resources/Skills`                                 |                                                                                                    |
| `workflow.ts`: `WorkflowKey`, `WorkflowFieldType`, `WorkflowField`, `WorkflowStepDefinition`, `WorkflowStructure`, `WorkflowFieldValue`, `WorkflowDraftChange`, `WorkflowMoveImpact`, `WorkflowOpenItemRef`                                                           | `models/WorkflowStructure` and `models/WorkflowItem`                   | the diff and move impacts are rule outputs                                                         |
| `Workflow`, `WorkflowSlug`, `WorkflowApproverRef`, `WorkflowStepPeople`, `WorkflowVersionSummary`                                                                                                                                                                     | `models/Workflow`                                                      |                                                                                                    |
| `WorkflowItem`, `WorkflowItemState`, `WorkflowItemStep`, `WorkflowStepState`, `WorkflowStepPart`, `MyWorkSection`, `WorkflowHelperSelection`                                                                                                                          | `models/WorkflowItem`                                                  | parts and sections are rule outputs                                                                |
| `WorkflowStepComment`, `WorkflowStepAttachment`, `WORKFLOW_ATTACHMENT_MAX_BYTES`                                                                                                                                                                                      | `models/StepComment`, `models/StepFile`                                |                                                                                                    |
| `WorkflowNotification`, `WorkflowNotificationKind`                                                                                                                                                                                                                    | `models/Notification`                                                  |                                                                                                    |
| `WorkflowListEntry`, `WorkflowDetail`, `WorkflowPublishPreview`, `WorkflowBoard*`, `CreateWorkflowRequest`, `UpdateWorkflowRequest`, `SaveWorkflowDraftRequest`, `PublishWorkflowRequest`, `SetWorkflowPeopleRequest`, `AddWorkflowAdminRequest`                      | `resources/Workflows`                                                  |                                                                                                    |
| `WorkflowItemView`, `WorkflowCommandResult`, `StartWorkflowItemRequest`, `UpdateWorkflowItemRequest`, `SetWorkflowItemDescriptionRequest`, `WorkflowReasonRequest`                                                                                                    | `resources/WorkflowItems`                                              |                                                                                                    |
| `WorkflowStepView`, `WorkflowFieldView`, `WorkflowInputView`, `WorkflowSubStepView`, `SetWorkflowFieldRequest`, `ReassignWorkflowStepRequest`, `SendBackWorkflowItemRequest`, `AddWorkflowCommentRequest`, `CallInWorkflowHelperRequest`, `AddWorkflowSubStepRequest` | `resources/WorkflowSteps`                                              | the step view gains `missing`, from the same rule as the gate                                      |
| `MyWork`, `MyWorkRow`                                                                                                                                                                                                                                                 | `resources/MyWork`                                                     |                                                                                                    |
| `TeamWork`, `TeamWorkGroup`, `TeamWorkRow`                                                                                                                                                                                                                            | `resources/Teams`                                                      |                                                                                                    |
| `WorkflowUnreadCount`                                                                                                                                                                                                                                                 | `resources/Notifications`                                              |                                                                                                    |
| `STEP_TOOLS_MCP`, `WorkflowAgentBrief`, `WorkflowHelperProposal`, `WorkflowHelperValue`, `StepToolCall`, `STEP_TOOL_NAMES`                                                                                                                                            | `resources/StepTools`                                                  | consumers are the step's agent and the server, not the browser; the tool script checks only shapes |
| `WORKFLOW_DRAFTING_MCP`, `WORKFLOW_DRAFT_TOOL_NAME`, `WorkflowDraft`                                                                                                                                                                                                  | `resources/WorkflowDrafting`                                           |                                                                                                    |
| `runnerStatus.ts`: `RunnerStatus`                                                                                                                                                                                                                                     | `resources/RunnerStatus`                                               | the runner's inventory decorated with T45's chats; the undecorated half is `RunnerInventory`       |
| `runner.ts`: everything                                                                                                                                                                                                                                               | `resources/RunnerVms`                                                  |                                                                                                    |
| `chatAttachment.ts`: `ChatAttachment*`, limits, MIME helpers, `getAttachmentLimitError`                                                                                                                                                                               | `models/Attachment`                                                    | done                                                                                               |
| `AttachmentUploadInput`, `AttachmentUploadResult`, `ATTACHMENT_ROUTE_PREFIX`                                                                                                                                                                                          | `resources/Files`                                                      |                                                                                                    |
| `AttachmentDeleteInput`                                                                                                                                                                                                                                               | `resources/Attachments`, inline                                        |                                                                                                    |
| `composerContext.ts`: everything                                                                                                                                                                                                                                      | `models/ComposerContext`                                               | done                                                                                               |
| `chat.ts`: `ChatStatus`, `ChatInputId`, `ChatInputMetadata`, `ChatNoteMetadata`, `ChatPendingInput`, `ChatMessage`                                                                                                                                                    | `models/Chat`                                                          | `ChatMessage` is how T45 keeps an OpenCode message; `ChatSessionId` is OpenCode's `Session.ID`     |
| `ChatInfo`, `ChatPreview`, `ChatList`, `ChatSession`, `ChatQuestion`, `ChatEvent`, the eleven `Chat*Input`/`ChatRef`/`ChatHistoryResult`                                                                                                                              | `resources/Chats`                                                      | payloads inline                                                                                    |
| `ChatError`                                                                                                                                                                                                                                                           | `models/Chat` as `Refused`                                             |                                                                                                    |
| `server.ts`: `ChatAgent`, `ChatAvailability`, `ServerConfig`                                                                                                                                                                                                          | `resources/Server`                                                     | `ChatAgent` picks from `Agent`                                                                     |
| `scheduledTask.ts`                                                                                                                                                                                                                                                    | `models/ScheduledTask`, `resources/ScheduledTasks`                     | moved untouched; removed with the feature                                                          |
| `rpc.ts`: `WS_METHODS`, the `Ws*Rpc` constants, `WsRpcGroup`, `RpcMemberAuthorization`                                                                                                                                                                                | `resources/RpcApi` and each resource                                   | `WS_METHODS` goes                                                                                  |
| `serverHttp.ts`: the four `*Reason` unions, five `Server*Error` classes, `ServerHttpCommonError`, `ServerHttpConflictError`                                                                                                                                           | delete                                                                 | replaced by model refusals, `NotFound`, `NotAMember`, defects                                      |
| `ServerAuthenticatedPrincipal`, `ServerAuthenticatedAuth`                                                                                                                                                                                                             | `resources/Session`                                                    |                                                                                                    |
| the `auth`, `org`, `agents`, `workflows`, `webhooks` groups, `ServerHttpApi`                                                                                                                                                                                          | their resources; `Files`, `Session`, `Webhooks` keep `HttpApi`         |                                                                                                    |
| `index.ts`                                                                                                                                                                                                                                                            | delete                                                                 |                                                                                                    |

Also gone on the server: `httpApi.ts`'s `fail*` helpers, every `map*Error` switch, `UserRepository.User`, `TeamRecord`, `WorkflowRecord`, `ItemRecord`, `StepRecord`, `NotificationRow`, `ChatRow`, `InputRow`, `DirectoryPerson`, and the per-domain `*StorageError` classes. On the web: `apps/web/src/http/{agents,org,workflows}.ts`, `describeHttpFailure`'s reason maps, and the duplicated `blocksMove`, `missingFields`, `draftProblem` and last-admin check.

## Decisions for you

- **One transport for member-facing JSON.** Decided, and over plain HTTP rather than the socket the proposal recommended: everything a signed-in member asks for is an RPC of the one `RpcApi` group at `POST /api/rpc`, each request authenticated on its own and streams sent as ndjson, so there is one kind of resource, one client and one auth middleware. The socket is gone, and so is the server's `HttpApi`: bytes, the cookie routes, avatars and webhooks are raw routes.
- **One package.** Recommended over two packages; the lint enforces the boundary.
- **Repositories on the server.** Recommended over declaring repository interfaces beside the model: no consumer but the server could use them, and the web would see storage it cannot reach.
- **Storage failures as defects** in request/response services. Recommended; it deletes a whole error tier. This reverses `server-cleanup.md`, which asks for typed storage errors (the `ChatAccess` and organization notes): nothing in a request path recovers from a failed write, so a typed error there only feeds a mapping to a generic failure.
- **Pilot: skills.** The organization looked smallest but its name is read by the sign-in gate before the socket opens, so the pilot became `models/primitives.ts` and then `Skill`: two tables, one service, four requests and one editor page. Then agents; then the organization and its members once the gate's checks fold into the session state; then workflows one resource at a time, starting with `WorkflowStructure` because it ends the editor/server split; chats last, since they are already RPC and mostly move files; that step also questions every chat limit (attachment counts and sizes, prompt length) and keeps only the real ones, such as what model providers accept. Scheduled tasks move untouched, or are removed first. The schema is edited in place, no compatibility shims, and the AGENTS.md code map and `docs/internals/overview.md`'s `rpc.ts` link are rewritten in the change that makes them wrong.
