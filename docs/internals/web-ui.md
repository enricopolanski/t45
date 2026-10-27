# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui). [AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element: layout and one-off styling live there.

- A recipe repeated across components is an `@utility` in [`index.css`](../../apps/web/src/index.css), written with `@apply` so theme tokens stay enforced: `card`, `control-frame` (Input, Textarea, SelectTrigger), `focus-ring`, `edge-highlight`, `popup-item` (Menu, Select and Combobox items), `popup-viewport` (Popover, Tooltip), and the glass surfaces (`glass`, `dialog-glass`, `dropdown-glass`, `alert-glass`). Make one at the third copy, not before.
- tailwind-merge can't see inside a recipe, so a call-site class overrides it only by coming later in the compiled CSS, and Tailwind orders utilities by the properties they set. Most recipes come before the plain utilities, but the glass surfaces come after the color utilities, so a `bg-*` or `border-*` class can't tint them. Check the compiled order (`/src/index.css?direct` on the dev server) when a call site overrides a recipe.
- A state-heavy look of one feature is a nested `@layer components` block with its states as `data-*` attributes or `:has()`: the toast stack (`[data-slot="toast"]`), the message actions (`.message-actions`), the composer's glass, which a docked drawer takes over (`.chat-composer`, `.composer-drawer`), the context chip, its kind and state as `data-kind` and `data-state` (`.context-chip`), and the Markdown alert, its kind as `data-alert` (`.chat-markdown-alert`).
- Other global CSS is only for what classes can't express: generated Markdown or imperative DOM, custom elements and shadow roots, animations, runtime CSS variables, and browser integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at runtime are fine.
- The app has one light theme. Don't add `dark:` variants, `@variant dark` blocks or `.dark` selectors.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object of small slots. Slots own their classes, take `className`, and spread the rest of their props, merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control renders `Button`.
- [`ConnectionNotice.tsx`](../../apps/web/src/components/chat/ConnectionNotice.tsx) renders a lost connection as an attached alert row.
- Consumers are a few lines of slots, and the slots carry the styling: [`ComposerLoadingBanner.tsx`](../../apps/web/src/components/chat/ComposerLoadingBanner.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes. When a call site repeats a treatment another one already uses, make it a variant or a slot on the shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Server data

Pages read server data through atoms built with `apiQuery` in [`state/rpc.ts`](../../apps/web/src/state/rpc.ts). `useLoaded` in [`state/query.ts`](../../apps/web/src/state/query.ts) suspends until the first value, and the route's pending and error views, or a `<Loading>` boundary such as the one around `WorkFrame`'s column, show loading and failures.

An atom that needs another atom's value reads it with `get.result` or `get.resultOnce` inside its own computation.

## Compiled components

The React Compiler memoizes components and JSX on their inputs, and the chat view and timeline leave memoization to it: the timeline's memoized rows rely on the chat view passing stable callbacks. Re-rendering a parent doesn't re-run a child whose props didn't change, so a formatter that reads `Date.now()` keeps its first answer: a relative time reads `now` from `useNowMinute` in the component that renders it and passes it to the formatter.

The compiler silently skips a component it can't compile, such as one with a `try`/`finally`, or with a `throw` or a conditional, logical or optional-chaining expression inside a `try`, which is why the send pipeline lives in `chat/sendChatMessage.ts`. The build reports nothing when it skips one: run `babel-plugin-react-compiler` with a `logger` and look for `CompileError` events before relying on it in place of a `useCallback` or `useMemo`.

`useEffectEvent` only works in plain function components: react-dom 19.2 never updates its callback inside `memo` or `forwardRef` components (the chat composer is one), so it keeps reading the first render's values. Use a ref written in a layout effect there.

## Chat view

ChatView measures the composer overlay's height together with the layout it measured it in: an old height with a new layout shrinks the timeline's inset for a frame, which clamps its scroll.

## Rendered messages

Copying from a rendered message puts the selected part of the message's original Markdown on the clipboard, never text rebuilt from the DOM. The parse pipeline stamps every element with its source offsets (`data-md`), and [`copy.ts`](../../apps/web/src/components/markdown/copy.ts) maps the selection's ends onto them. A markdown renderer that replaces an element must keep that working: forward `data-md` to its root, mark a rendering that stands for its whole source (a chip, an image, a code block) with `data-md-whole`, and mark UI the source lacks (headers, titles, toolbars) `data-md-ui` and icons `aria-hidden`: copying and citing both skip them.
