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

/**
 * File names of letters, digits, `.`, `_` and `-`, each starting with a letter or digit, joined by
 * `/`. No whitespace, no `.` or `..`, no hidden files.
 */
const RelativePath = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/),
);

const isInside = (path: string, folder: string) => path.startsWith(`${folder}/`);

/**
 * Files by path, as written into a folder: none at or inside a `reserved` path, which the runner
 * writes itself, and none inside another file.
 */
export const FilesByPath = (reserved: ReadonlyArray<string>) =>
  Schema.Record(Schema.String, Schema.String).check(
    Schema.isPropertyNames(RelativePath),
    Schema.makeFilter(
      (files: { readonly [path: string]: string }) => {
        const paths = Object.keys(files);
        return paths.every(
          (path) =>
            !reserved.some((taken) => path === taken || isInside(path, taken)) &&
            !paths.some((other) => isInside(path, other)),
        );
      },
      { expected: `files outside ${reserved.join(", ")} and outside one another` },
    ),
  );

/** A plain string of 6–50 characters. */
const StringIdSchema = Schema.String.check(Schema.isMinLength(6), Schema.isMaxLength(50));
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
