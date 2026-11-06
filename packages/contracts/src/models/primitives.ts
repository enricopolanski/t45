import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
/**
 * Non-empty once trimmed. `make` and encode check the value before it is trimmed, so the check
 * trims it itself: with a plain `isNonEmpty`, `make(" ")` would succeed and encode to `""`.
 */
const isNonEmptyAfterTrimming = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a string that is non-empty after trimming",
});
export const TrimmedNonEmptyString = TrimmedString.check(isNonEmptyAfterTrimming);

export const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Relative file paths that cannot collide with the runner's generated files and folders. */
export const FilesByPath = (reserved: ReadonlyArray<string>) =>
  Schema.Record(Schema.String, Schema.String).check(
    Schema.makeFilter(
      (files: Readonly<Record<string, string>>) =>
        Object.keys(files).every(
          (path) =>
            path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
            !reserved.some(
              (taken) =>
                path === taken || path.startsWith(`${taken}/`) || taken.startsWith(`${path}/`),
            ),
        ),
      { expected: `relative file paths outside ${reserved.join(", ")}` },
    ),
  );

const StringIdSchema = Schema.String.check(Schema.isMinCodePoints(6), Schema.isMaxLength(50));
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Generates a 21-character URL-safe identifier. */
export const generateId = () =>
  Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(21)),
    (byte) => ID_ALPHABET[byte & 63],
  ).join("");

export const StringId = Object.assign(StringIdSchema, {
  /** Generates an id only when omitted during construction, never during decoding. */
  withConstructorDefault: StringIdSchema.pipe(
    Schema.withConstructorDefault(Effect.sync(generateId)),
  ),
});
export type StringId = typeof StringId.Type;

/** A branded identifier: trimmed when decoded or encoded, and never empty after trimming. */
export const makeId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) => {
  return TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));
};

/** Shared by attachment records and workflow file fields without coupling their models. */
export const AttachmentId = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/,
  ),
);
export type AttachmentId = typeof AttachmentId.Type;
