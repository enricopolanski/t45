Write a working Chrome extension whose only function is to save a DOM snapshot of the page I am currently viewing.

The extension must provide exactly one button: its icon in the Chrome toolbar. Clicking that button captures the current page and downloads the snapshot. Do not add a popup, dashboard, settings page, website overlay, or a second confirmation button.

I will give the saved snapshots to an AI later, outside the extension, to extract competitor product information. The extension itself must perform no product extraction and make no AI calls.

**Context and scope**

My application has an agent called Competitor price checker. It reads competitor product pages to find titles, identifiers, specifications, prices, availability, selected variants, pack sizes, and content quantities. I want to preserve the page content so that an AI can read those facts later without reopening the website.

This context explains why the DOM must be preserved. It does not authorize implementing the price checker inside the extension. Do not extract or calculate prices, ASINs, EANs, quantities, unit prices, or product matches. Do not define a normalized product schema or build collection integration.

The entire user flow is:

1. I open a competitor product page in my normal Chrome session.
2. I choose the variant, delivery location, or other options myself and wait until the page shows what I want to capture.
3. I click the extension's toolbar button.
4. Chrome downloads one JSON file containing that page's current DOM and basic capture metadata.

Each click is a new capture of the page as it exists then. There is no automatic capture, background monitoring, crawling, or navigation.

**Implementation**

Use a minimal Manifest V3 extension with plain JavaScript. This feature does not need React, a UI framework, a bundler, or a backend. Make the source directory directly loadable through Chrome's “Load unpacked” command.

Use the native extension action as the button. Define an informative `action.default_title`, such as “Save page snapshot”, and do not define `action.default_popup`.

Register `chrome.action.onClicked` in the extension service worker. Use the clicked tab's ID as the capture target. Use `chrome.scripting.executeScript` to read its main document. The injected function must be self-contained and must not depend on closures or variables from the service worker.

Request only these permissions:

```json
["activeTab", "scripting", "downloads"]
```

Do not request permanent access to all websites, cookies, browsing history, network interception, debugger access, or access to other tabs. The user invokes capture explicitly on the current tab. Chrome supports this through [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) and the [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

**What the snapshot contains**

Save a UTF-8 JSON object with this shape:

```ts
type PageSnapshot = {
  snapshotVersion: 1;
  capturedAt: string;
  url: string;
  title: string;
  html: string;
};
```

- `capturedAt`: an ISO 8601 UTC timestamp recorded when the DOM is captured.
- `url`: the actual `location.href` of the captured document, including its query string and fragment. Do not replace it with a guessed canonical product URL or remove parameters that may identify the selected variant.
- `title`: the document's current title.
- `html`: the current main document's doctype, when present, followed by `document.documentElement.outerHTML`.

Read the URL, title, timestamp, and HTML together inside the injected capture function, so they describe the same document at the time of capture.

Capture the live DOM after the website's JavaScript has updated it. Do not use `fetch`, download the original server response, reload the page, or open another browser session. The snapshot must reflect the page I already opened and interacted with.

Preserve the serialized markup without summarizing, cleaning, truncating, or selecting only product-related sections. Keep the attributes, tables, links, hidden elements, scripts, and embedded JSON-LD already present in the DOM. These are captured as text for later analysis; do not execute their contents or render them inside an extension page.

Do not separately extract visible text, structured product data, or business fields. Do not read cookies, local storage, session storage, or network responses. The requested artifact is the DOM snapshot itself.

This is a main-document DOM serialization, not a screenshot or an offline copy of the entire website. Do not download images, stylesheets, fonts, or linked resources. Do not add a screenshot feature.

Document the actual limitations in the README: unloaded content is absent; iframe documents and shadow roots are not included by `outerHTML`; runtime state that exists only in JavaScript properties may not appear in the serialized attributes. Do not claim that the file contains the browser's complete state. These limitations do not require building a more elaborate capture system for this version. See the [DOM serialization documentation](https://developer.mozilla.org/en-US/docs/Web/API/Element/outerHTML).

**Saving the file**

Download one `.json` file per click using `chrome.downloads.download`, with `saveAs: false` and `conflictAction: "uniquify"`. Respect the user's Chrome download preferences.

Use a readable filename containing the hostname and capture timestamp, for example:

```text
competitor-snapshots/www.amazon.de-2026-11-14T18-30-00-123Z.json
```

Sanitize the filename so it contains no invalid path characters. Preserve Unicode correctly inside the JSON, including German product text, the euro symbol, and non-ASCII product names.

Use a download URL that works from a Manifest V3 service worker. An encoded JSON data URL is sufficient for this first implementation; do not assume that a service worker has `document` or `URL.createObjectURL`. Do not introduce an offscreen document, ZIP generation, or an asset archive for this feature. Use the [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) and handle rejected download requests.

Do not store a second copy in extension storage. The downloaded file is the saved snapshot. There is no snapshot history, database, synchronization, upload, or T45 API call in this version.

**Failure handling**

Keep error handling small and understandable:

- If Chrome does not allow script injection on the selected page, report that capture is unavailable there.
- If the tab closes or navigation interrupts capture, report that the snapshot could not be created.
- If capture or download fails, do not create an empty file or show success.
- Use Chrome's normal download UI for the download. For failures, a short action badge and an explanatory action tooltip are enough; also log the technical error for debugging. Clear an old error when the next capture starts.

Do not add retries, automatic navigation, or logic for bypassing access restrictions. If the current page is a login page or a website error page, capturing its DOM is still a valid snapshot. The extension does not decide whether it is a usable product observation.

**Files and delivery**

Create the complete extension, with at least:

```text
competitor-snapshot/
  manifest.json
  service-worker.js
  README.md
```

The service worker can contain the small injected capture function. Add a separate capture file only if it makes the implementation clearer. Avoid unnecessary dependencies and abstractions.

The README must explain how to load the folder as an unpacked extension, pin its icon, open a product page, click the button, and locate the downloaded JSON. Include the snapshot format and the concrete capture limitations described above.

Verify the behavior in a real Chrome or Chromium extension environment when available:

1. One toolbar click produces one valid JSON file with the captured page's URL, title, UTC timestamp, and DOM.
2. Content inserted into the page by JavaScript before the click appears in the snapshot.
3. Changing page content and clicking again produces a new snapshot containing the updated DOM.
4. Unicode survives JSON serialization and download unchanged.
5. A restricted page fails clearly without downloading a misleading snapshot.

Use a simple local HTML page for repeatable verification. Do not run the existing Competitor price checker automation: it costs money and tokens. Do not claim browser checks passed if you could not run them; report what was actually verified and provide the remaining manual steps.

If you have filesystem access, write the files and verify them. Otherwise, provide the complete contents of every required file, ready to save. Do not stop at a plan or provide pseudocode, placeholders, or TODOs for the capture and download behavior.

The finished result must remain this simple: one toolbar button, one DOM snapshot file per click. AI extraction happens later and is outside this task.
