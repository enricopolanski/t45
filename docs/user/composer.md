# Messages and context

Give the agent a task in the composer. Add files when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so the agent can inspect it without filling the model context. A smaller paste also becomes an attachment when inserting it would exceed the message limit. On a hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere to keep a large paste editable in the composer instead.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most 80 MiB of images in one message. Other files can be up to 50 MiB each, subject to the server's upload limit. The agent receives them on its machine. Provider and model limits still apply, including images already in the conversation.

Uploads begin when you add an attachment. All uploads must finish before the message can send. Retry or remove a failed upload. Reloading before an upload finishes requires you to attach that file again.

You can drag or paste images into the composer. HEIC and HEIF photos are converted to JPEG, and photos over the image limit are resized to fit.

See [images in messages](#images-in-messages) for opening and saving images.

## Who you are talking to

Every chat is with an agent. Its model and permissions are part of the agent, set when the agent is defined in **Agents**, so the composer has nothing to choose. A new chat continues with the agent of the chat you are in; start one with another agent from **Chat**. A new chat joins your chat list once you send it something; one you leave empty is removed a day later.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this chat. Press `ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest prompt clears the composer. Recall walks the prompts loaded in the chat. Attachments and other extras from the original message are not restored, only the text you typed. A composer that holds an attachment does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it into a normal draft.

## Queued messages

The composer shows **Interrupt** while the agent is working and the draft is empty. Adding text or attachments replaces it with a queue icon. Click it or press `Enter` to queue the message; it starts after the active turn ends. Queued messages are saved on the server, so they survive a restart.

Queued messages appear above the composer, with a thumbnail of any attached image. Cancel one with its row's remove control until the agent takes it up. **Interrupt** stops the turn and cancels every queued message with it.

## Commands

Type `/` for commands: `/new` starts a chat with the same agent and `/compact` summarizes the conversation to free up context. A command runs when it is the whole message.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text, such as a file. You can type before and after a chip and delete it like a character. Hover a chip for its brief details. Chips read as "File", "Image" and similar to screen readers.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing the thumbnail asks first when the image is still mentioned in your text, then removes both. Files exist only as chips: deleting a file's last chip removes the file from the message.

Chips don't travel through copy and paste. Copying text with chips, from the composer or a sent message, gives you each chip's name as plain text; attach the image or file again if the agent needs it. A chip whose context is no longer available shows a dashed outline; hover it for what to do.

## Attached files

Selecting a file in a sent message downloads it.

## Images in messages

Select an image, one you attached or one in an agent's reply, to preview it.

File paths in a reply point at the agent's machine, so they show as code rather than links.
