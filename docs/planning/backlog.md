# Backlog

Future work that is understood but not scheduled.

- **Authenticated local verification.** The web app's only door is Clerk, and a worktree ships no Clerk configuration, so a local dev server cannot exercise signed-in flows (Home, org surfaces, member areas) in a browser. Decide and build one path: a Clerk development instance wired through the worktree env, a seeded dev session, or a documented reusable dev credential flow. Then run the `drive-browser` pass for authenticated flows.
