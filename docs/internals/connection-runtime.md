# Connection runtime

The web client talks to the server it was loaded from over one transport: RPC over `POST /api/rpc`, with a stream's items sent as ndjson on its own request ([`rpc/api.ts`](../../apps/web/src/rpc/api.ts)). There is no socket, no connection session and no server discovery; client state carries no server id, and chats, drafts and queries are keyed by their own ids. Every call carries the session cookie and is authorized on its own (see [server auth](./server-auth.md)).

## Calls and watches

A unary call (`api`, `call`) is one attempt. Nothing replays a mutation, whose retry and idempotency rules belong to the operation, and a server defect fails only its own call. A watch (`watch`) holds one stream and subscribes again when the tab is shown again, when the browser reports it is online, and after a transport failure, with jittered exponential backoff capped at five minutes. Nothing pings: a held fetch can die silently while a laptop sleeps, and showing the tab or coming back online replaces it. Without jitter, every tab of a restarted server resubscribes in the same second; with a short cap, a tab that can never connect retries all day. Any other failure, a refusal or a defect, ends the watch, since subscribing again would fail the same way.

A tab holds at most two streams, the chat list and the open chat, plus the chat just left for 2 seconds. Browsers allow six HTTP/1.1 connections per host and Vite's dev proxy speaks HTTP/1.1, so a third long-lived stream per tab would leave two tabs no room for calls.

## Reachability

`reachableAtom` is the one transport flag. A transport failure of any call or watch sets it false; any answer, a refusal or a defect included, sets it true; a session read proves nothing about `/api/rpc` and leaves it alone. It is written only when it changes, because each turn from false to true re-runs the queries that failed for the transport, retries failed uploads and re-reads the session. A page holding no watch recovers at its next call, or when the tab is shown again and its failed queries run again, so sends are never blocked while the flag is false: the send is what finds the server again. The chat's "Reconnecting…" banner shows after a 2-second grace, and compacting waits for reachability. A failed stream or query on a reachable server is not reconnecting, and its error shows as the failure it is.

## Snapshots replace state

Data loaded before a transport failure stays readable while the watch restarts. Folding snapshots belongs to the shared state services: a watch's transform folds across its restarts, so every view agrees on which data is current.

The client keeps no cache, on disk or across streams: a reload, or a return to a chat whose stream has closed, loads a fresh snapshot of its recent window (`chats.watch`). [Chat state](../../apps/web/src/state/chats.ts): the mounted views of one chat session share one stream, which closes 2 seconds after the last of them unmounts. Users keep a handful of chats open and the window is small, so faster returns were not worth the stale-data and ordering races a cache brings: a still-streaming part's copy has empty text, so a cached state seeded into a new stream would keep its old prefix and append new deltas to it, losing everything streamed while away. Returning after 2 seconds shows loading for one round trip. There is no sequence to resume from: a restart subscribes again, and the new snapshot replaces what the client held, keeping text streamed past a live message's copy. Pages loaded with "Load earlier messages" stay only while they still join the new window. The chat list has no cursor either; a restart receives the whole list again.

## A signed-out tab reloads

The sign-in gate's admission is memoized, so nothing else would send a tab whose session ended back to `/login`. Every `AccessDenied` reaches `onAccessDenied`, which [the root route](../../apps/web/src/routes/__root.tsx) sets to `checkSignedOut`: it re-reads the session and does a full reload to `/login?signedOut=true` only when that read answers `isAuthenticated: false`. An admin-only refusal finds the session signed in and changes nothing, and a read that fails for the transport is ignored. A session refresh that answers signed out reloads the same way. Signing out elsewhere revokes every other session, whose held streams fail at once; the current browser stays signed in.
