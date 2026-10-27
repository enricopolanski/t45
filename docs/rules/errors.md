# Errors

## Refusals

A refusal is the domain declining a well-formed request because of the current state of the application.

- A name is valid, but already taken.
- An admin attempts to remove themselves, but they're the last admin in the application.

This is separate from a malformed request (a decode failure) or a broken system (an infra error).
