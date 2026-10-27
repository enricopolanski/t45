# Repositories

## Handlers never touch storage

A handler (`*.handlers.ts`) never imports `SqlClient` or writes a query. It reads and writes through repositories, so a change in how something is stored never reaches the code that serves requests.

## A repository owns everything about storing its entity

One repository per entity (`agents/AgentRepository.ts`, `agents/SkillRepository.ts`) holds every query, every transaction, and every rule about the stored collection, such as a name no other row may have. Its methods take and return the model (`Agent`, `Skill`), and its failures are the model's refusals; storage failures are defects.

- Reads: `list`, `get`, and named filters for what callers actually ask, such as `SkillRepository.listForAgent`, or an `AgentRepository.listConversational` if a caller needs only those agents.
- Writes: `save` (or `insert` and `update`) and `remove`, each atomic on its own. A write that sets a name refuses `name_taken` itself.

## Handlers decide, repositories store

A handler checks what the request needs (the caller's permission, a model the runner offers, skills that exist), builds the entity's next value (`{ ...agent, status: "archived", updatedAt }`), and hands it to the repository. Rules that involve other entities read them through those entities' repositories, never with a join of their own.
