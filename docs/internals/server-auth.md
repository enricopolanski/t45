# Server auth

The server issues its own sessions and enforces their capabilities.

## Every request is authorized on its own

Clerk establishes identity; the server’s organization membership determines admission. A user’s id is the Clerk token’s `sub`, so moving to another Clerk instance leaves every existing user behind. The browser exchanges a Clerk session token once for the server’s own session, an HttpOnly cookie holding a random token, which then authenticates every request. The database keeps only the token’s hash, and every request reads the user’s current role and state through it, so a session carries no claims that could go stale. Login checks membership and issues the session in one transaction so a concurrent deactivation cannot race session creation.

The browser mounts Clerk only inside the login surface, with the publishable key the server advertises; Clerk throws when providers nest, so nothing above `/login` may mount another.

The cookie is named after the server’s state directory: cookies are scoped by host, not port, so parallel dev servers on one machine would otherwise sign each other out.

Every RPC is a request of its own over `POST /api/rpc`: [the RPC session middleware](../../apps/server/src/auth/Authorization.ts) reads the cookie on each unary call and at each stream’s start, and turns away a user who is not an active member, such as a registration still awaiting approval, before any handler runs. A unary call sees a role or state change at its next request. A held stream, which the middleware tells from a unary call by its success schema (`RpcSchema.isStreamSchema`), was authorized when it started, so declining, deactivating or changing a member’s role ends their sessions, and each stream races its session’s revocation and fails with `AccessDenied`. The stream subscribes to revocations before it authenticates, because nothing replays them: one published while it authenticates would otherwise be missed. Approving a member keeps their sessions, since a pending member holds no stream and their next request reads the new state. The plain HTTP routes for attachments, avatars and traces refuse inactive sessions too, through [one `member` check](../../apps/server/src/auth/http.ts). Those routes and the sign-in routes refuse with one fixed body, [`AuthFailure`](../../packages/contracts/src/resources/Session.ts) (`{ error }`): no session is 401 `unauthenticated`, a member who isn't active 403 `inactive`, a Clerk token that doesn't verify 401 `invalid_credential`, a deactivated account 403 `deactivated`, and a session store or Clerk that can't be reached 500 `internal_error`, with the cause logged and never sent.

## Cross-site requests are refused

The cookie is `SameSite=Lax`, which still goes along on a top-level cross-site form post, so CSRF does not rest on it alone. [A global middleware](../../apps/server/src/http.ts) (`layerSameOrigin`) answers 403 to every request that isn’t `GET`, `HEAD` or `OPTIONS` unless `Sec-Fetch-Site` is `same-origin` or `none`, or its `Origin` is absent or names the request’s `Host` or the dev server’s host. The dev host passes because Vite’s proxy rewrites `Host` but not `Origin`. Webhooks under `/api/hooks/` are exempt: other sites send them, and each carries its automation’s token.

## Attachments ride the session cookie

Chat and step files travel over [one upload and one download route](../../apps/server/src/attachments/http.ts) under `/api/attachments`, so images, downloads, and uploads are ordinary browser requests. The session cookie authorizes them like any other request, and only for approved members. A file is readable when it is the current user's own pending upload, when a chat holding it is one the current user may open, or when the step holding it is on a ticket the current user may view; anything else is 404, never 403, so possessing a URL never grants another member or administrator access, nor tells them the file exists. The name and type a download is served with come from the stored file, not the URL. The app and the server share one origin, so the cookie always goes along, and a URL copied out of the app grants nothing without a session. Only images render inline (SVG in a sandbox); every other attachment, HTML included, downloads under a sandboxing policy, so it cannot run as the app or fetch other attachments.

## Access follows the chat's origin

The first member input creates a private Conversation owned by that member, including against organization admins. A Task derives access from its trigger: admins for Automations, and the workflow's ticket visibility for step tasks. The chat list queries a member's Conversations and, for admins, Tasks. Members reach step chats from their workflow. Opening a step chat delegates to ticket visibility; mutations require involvement through the existing workflow rule. Attachment access uses the same origin check. A chat stream is authorized when opened; session revocation ends held streams. Chat execution knows none of these identities.

The origin, Chat and first input are created in one transaction. Clients cannot select a Conversation's owner or attach a new origin to an existing Chat. A different agent under an existing id is `id_taken`; a tombstone cannot be reused. Task chat commands enter TaskService so direct chat RPCs cannot reopen settled work or bypass workflow eligibility.

## Admin-only surfaces

An admin-only RPC says so in its contract with the [`AdminOnly` middleware](../../packages/contracts/src/Authorization.ts), which refuses any other role with `AccessDenied` before the handler runs. Every agent call but `agents.list` is admin-only, as are skills, renaming the organization, and approving, declining, changing the role of, deactivating or reactivating a member.

Every Automation configuration call is admin-only. Each firing, manual run or accepted webhook creates its own Task and Chat; source configurations are disabled rather than deleted so each historical task retains its source configuration. A webhook's signing secret is a field of its schedule, readable by admins like the token in its URL, which is the same kind of credential.

The runner page (`runner.get`) is admin-only, and a VM's row names its chat only when that admin may open it; a member's chat shows as one the admin can't open.

## Profile identity belongs to the member

A new user gets Clerk's non-empty name, falling back to their email or subject. The stored display name is always non-empty. Later sign-ins refresh email but preserve the name and avatar, which the user can edit. Accepted images are stored locally and served only to active members at `/api/avatars/:userId`, which stays plain HTTP while every other user and organization request is RPC, so an `<img>` can load it with the session cookie. Choosing Clerk's picture copies it rather than retaining an external image dependency. Profile editing is available from the account menu; it is not an admission gate. New users start with a slate letter avatar, and avatar images are served with revalidation rather than versioned URLs.
