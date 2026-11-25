import * as DoSqlite from "@effect/sql-sqlite-do/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";

import { runMigrations } from "../src/persistence/Migrations.ts";

const failure = (operation: string) => (cause: unknown) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: `Failed to ${operation}`, operation }),
  });

/**
 * The published client runs `afterCommit` callbacks at once, even in a transaction that then rolls
 * back, and T45 starts executions and publishes changes from them. Its transactions go through
 * Effect's `makeWithTransaction` here instead, which keeps each level's callbacks until the outermost
 * commit, as on Node. Each level holds a `storage.transaction()` open until it commits or rolls back.
 */
const make = (storage: DurableObjectStorage) =>
  Effect.gen(function* () {
    const client = yield* DoSqlite.make({ storage });
    /** How each open level ends its storage transaction, by nesting depth. */
    const levels = new Map<number, (rollback: boolean) => Promise<void>>();

    const open = (id: number) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((started, refused) => {
            const done: Promise<void> = storage.transaction(
              (transaction) =>
                new Promise<void>((settle) => {
                  levels.set(id, (rollback) => {
                    if (rollback) transaction.rollback();
                    settle();
                    return done;
                  });
                  started();
                }),
            );
            // Refused before its callback ran, the transaction never started.
            done.catch(refused);
          }),
        catch: failure("begin"),
      });

    const close = (id: number, rollback: boolean) =>
      Effect.suspend(() => {
        const end = levels.get(id);
        // A savepoint rolled back is released afterwards too.
        if (end === undefined) return Effect.void;
        levels.delete(id);
        return Effect.tryPromise({ try: () => end(rollback), catch: failure("commit") });
      });

    const withTransaction = SqlClient.makeWithTransaction({
      transactionService: client.transactionService,
      spanAttributes: [["db.system.name", "sqlite"]],
      acquireConnection: (restore) => restore(client.reserve),
      begin: () => open(0),
      savepoint: (_connection, id) => open(id),
      releaseSavepoint: (_connection, id) => close(id, false),
      commit: () => close(0, false),
      rollback: () => close(0, true),
      rollbackSavepoint: (_connection, id) => close(id, true),
    });

    return Object.assign(client, {
      // An open storage transaction closes the object's input gate, so the fiber must not wait on timers to resume.
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withTransaction(effect).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
    });
  });

/** The instance's database is its Durable Object's SQLite storage, migrated on every start. */
export const layer = (storage: DurableObjectStorage) =>
  Layer.effectDiscard(runMigrations).pipe(
    Layer.provideMerge(Layer.effect(SqlClient.SqlClient, make(storage))),
    Layer.provide(Reactivity.layer),
  );
