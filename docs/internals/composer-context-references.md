# Composer context references

> For maintainers. Using T45? See [docs/user](../user/).

Inline context references let a user message point at a typed payload from an exact position in its prose: an image or a file. This document covers the wire contract, the codecs, and how the editor, transcript, and clipboard treat them.

## Two linked concepts

- A **context record** is the payload. It lives in the message's `context.records`, keyed by a `contextId`. Records never contain bytes: image and file records bind to an existing `ChatAttachment` by id.
- A **context reference** is one occurrence in the document. It is a Markdown link in the message's `text` that carries only the kind and the `contextId`. Two references can point at one record. A reference's label is display text and never identity.

[`models/Chat.ts`][schemas] defines one record shape for images and files: its `contextId`, `kind` and `label`, the bound `attachmentId`, and the file's name, MIME type and size, all bounded. A record that does not decode fails the whole message. `ChatMessageContext` is optional on `chats.send` (its `context`); T45 keeps it unchanged with the input and then in the message it becomes (see [Ids and persistence](#ids-and-persistence)).

## Identity namespaces

- `ChatContextId`: durable payload identity. Branded. Values match `[a-z0-9_-]+` and do not require a `ctx_` prefix.
- `AttachmentId`: the server-owned attachment. A record's `attachmentId` is a binding, not the chip's identity: the chip's id comes from the draft attachment, so a chip has it before the upload has a server id.

An occurrence has no id of its own. The web derives context ids (see [Ids and persistence](#ids-and-persistence)); the contracts package mints none.

## Canonical reference syntax

The [shared reference helpers][references] own the grammar:

```text
[label](t45-context:<kind>/<contextId>)
![label](t45-context:image/<contextId>)
```

The parser accepts exactly the `t45-context:` scheme, a known kind, and an id matching `[a-z0-9_-]{1,128}` case-insensitively; anything else, including extra segments, is rejected. Labels are sanitized to survive a Markdown link (no brackets or line breaks, at most 200 characters, never empty). Links that fail to parse are ordinary text.

## What the agent reads

The server's [`PromptService.format(input)`][projection] builds the text OpenCode receives on the runner:

1. Every reference becomes an in-place marker: `[Image: shot.png; ref=ctx_1]`.
2. A trailing `<t45_context>` envelope holds one `<context kind id>` entry per unique referenced id, in first-reference order. Records that are never referenced are not emitted. A referenced id with no record becomes `<context … unavailable="true"/>`.
3. Captured text is data: any `<` that would open or close `t45_context` or `context` is escaped, so a file name cannot forge a record.

Attachment bytes go to the chat's VM as files under `/work/attachments`; the envelope only carries metadata. The service appends the files' VM paths and supplies a prompt for inputs containing only attachments. Both input length validation and delivery use this formatter. It also formats form answers with their attached files' paths.

[schemas]: ../../packages/contracts/src/models/Chat.ts
[references]: ../../packages/core/src/composerContextReferences.ts
[projection]: ../../apps/server/src/runner/PromptService.ts

## Editor model

The Tiptap `composer-context-reference` atom (`ComposerPromptEditor.tsx`) is the one inline node for every context kind. It stores `contextId`, `label`, and its `source` link, the canonical text it serializes back to. The prompt string carries payload identity and position, so rebuilding the editor restores equivalent chips.

Records stay in the draft store's typed arrays for now. The composer builds a `Map` keyed by `contextId` from them (`composerContextRecordsFromDraft`) and provides it, with what a chip can do, through `ComposerChipsContext`. `ComposerContextReferenceChip` looks the record up and renders the kind's chip; a missing record renders the unresolved chip instead of vanishing. Removing a chip removes only that occurrence; the composer's change handler compares the referenced ids against the draft array and drops records no chip points at.

Version 1 deliberately keeps kind presentation explicit in each client instead of exposing a runtime handler registry. The contract and codecs are shared; the web client renders rich chips. Add a registry only when a third-party or runtime-defined kind must provide behaviour that cannot ship with the client. Likewise, a durable occurrence id belongs in the canonical reference syntax only if a future feature needs to address one occurrence across serialization boundaries.

## Sending and reading messages

The composer sends the text as canonical prose with reference links and `context.records` built from the draft (`buildMessageContext` in `apps/web/src/lib/composerContextReferences.ts`). `PromptService` formats the text when T45 delivers the input: OpenCode's user message holds the markers and one envelope the agent reads, and `metadata.t45` keeps the member's text and records, which the transcript renders.

In the transcript, `Markdown` renders `t45-context:` links through `renderContextReference`, which the timeline maps to each kind's chip, or to the unresolved chip when the record or attachment is missing. Images in replies use the shared media modal.

## Attachments

Image and file records derive their `contextId` from the draft attachment's local id and carry an `attachmentId` binding. The composer sends the upload's id, which the attachment keeps once sent, so the stored message binds records to real resources. A sent input the agent hasn't taken up yet shows its chips as their labels: its records arrive with the message it becomes.

In the composer, attaching a file or image inserts a chip at the caret (appended when the editor cannot take input). Files exist only as chips: a file whose last chip is deleted is removed. Images keep the thumbnail shelf as their inventory; deleting a chip leaves the image, and removing a thumbnail that is still referenced asks for confirmation before removing both. Old drafts do not gain image chips.

In the transcript an image chip opens the image in the media viewer and a file chip downloads the file. The gallery still shows every image; file rows remain only for files no chip references.

Editor undo restores a deleted chip's link text but knows nothing about records. The composer therefore keeps the file of every file chip it removed (`reconcileAttachmentContextReferences`) and re-adds it when an undo brings the link back; images need nothing, since they stay on the shelf.

## Clipboard

Context never travels through the clipboard, not even within one draft: copying and pasting a chip is unsupported, and the user attaches the image or file again. Carrying it would need a structured clipboard payload plus a download and re-upload under a fresh id, for rare cases.

- Composer copy and cut write the serialized Markdown with every context link replaced by its label (`inlineContextReferencesToLabels`); the transcript and the message copy button do the same.
- Paste applies the same replacement before inserting, in the editor and in the redirected paste of a blurred composer. Pasted text cannot stay a literal link: the draft is the serialized string, so a link would come back as a chip with no record on the next parse and be sent as an unavailable reference.

## Ids and persistence

A context id is `<kind>_<draft attachment id>`; draft attachment ids are UUIDs, so context ids need no escaping.

A sent input keeps its records in `chat_inputs.payload_json` until it is delivered, and the message it becomes keeps them under `metadata.t45.context` (`InputMetadata`), so chips stay resolvable after a restart and after the chat's VM is restored.
