# Remote architecture

The server serves the web app, and the app connects only to that server, over HTTP on the same origin. There is no catalog of other servers, no pairing, and no route selection. The server owns durable state and agent configuration; agent work runs on the runner.

## Version skew

The server serves the web app and both ship together, so the wire has one version. Schemas are closed: nothing decodes members, kinds or fields from another build, and there is no wire-version negotiation or feature flags. An open tab can outlive a deploy; the server reports its embedded Git commit SHA in the session state (`deployVersion`), which a tab re-reads when it is shown again, once a minute while it stays visible, and when the server becomes reachable again after a transport failure, and the tab compares it with its own embedded SHA. A mismatch offers a reload, including for server-only changes and rollbacks. Neither side derives its identity from files that a deployment can replace beneath a running process. A server restart is a transport failure the connection runtime handles like any other; restarting the same commit does not prompt a reload. Source-mode development uses the fixed `development` identity on both sides.
