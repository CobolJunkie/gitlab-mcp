/**
 * Shared Zod schemas used across multiple GitLab tool families.
 * Domain-specific schemas remain in their respective domain modules.
 */

import * as z from "zod/v4";

export const project = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("GitLab project ID or full path such as group/project.");

export const groupIdentifier = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("GitLab group ID or full path such as parent/subgroup.");

export const iid = z
  .number()
  .int()
  .positive()
  .describe("Project-scoped internal ID.");

export const page = z.number().int().min(1).optional();

export const perPage = z.number().int().min(1).max(100).optional();

export const sha = z.string().min(7).describe("Commit SHA or Git ref.");

export const nonEmpty = z.string().min(1);

export const stringArray = z.array(z.string().min(1));

/**
 * Maximum nesting depth for structured CI/CD input values.
 * Keeps recursive validation bounded and prevents deeply nested payloads.
 */
const STRUCTURED_INPUT_MAX_DEPTH = 5;

/**
 * Maximum number of keys in a single object level.
 */
const STRUCTURED_INPUT_MAX_OBJECT_KEYS = 20;

/**
 * Maximum length of any single string value in a structured input.
 */
const STRUCTURED_INPUT_MAX_STRING_LENGTH = 10_000;

/**
 * Maximum number of elements in a single array level.
 */
const STRUCTURED_INPUT_MAX_ARRAY_LENGTH = 50;

/**
 * Build a bounded recursive Zod schema for structured CI/CD input values.
 *
 * Accepts JSON-compatible values — strings, numbers, booleans, arrays,
 * and objects with string keys — up to a configurable maximum depth.
 * Every level enforces object-key, array-length, and string-length caps.
 *
 * @param {number} depth - Current remaining depth (starts at {@link STRUCTURED_INPUT_MAX_DEPTH}).
 * @returns {import("zod/v4").ZodType} A Zod schema for the current depth.
 */
function boundedStructuredInput(depth = STRUCTURED_INPUT_MAX_DEPTH) {
  if (depth <= 0) {
    // At maximum depth only scalar values are allowed.
    return z.union([
      z.string().max(STRUCTURED_INPUT_MAX_STRING_LENGTH, {
        message: `Structured input strings must not exceed ${STRUCTURED_INPUT_MAX_STRING_LENGTH} characters.`,
      }),
      z.number(),
      z.boolean(),
    ]);
  }

  const scalar = z.union([
    z.string().max(STRUCTURED_INPUT_MAX_STRING_LENGTH, {
      message: `Structured input strings must not exceed ${STRUCTURED_INPUT_MAX_STRING_LENGTH} characters.`,
    }),
    z.number(),
    z.boolean(),
  ]);
  const child = () => boundedStructuredInput(depth - 1);

  return z.union([
    scalar,
    z.array(child()).max(STRUCTURED_INPUT_MAX_ARRAY_LENGTH, {
      message: `Structured input arrays must not exceed ${STRUCTURED_INPUT_MAX_ARRAY_LENGTH} elements.`,
    }),
    z
      .record(
        z.string().min(1).max(STRUCTURED_INPUT_MAX_STRING_LENGTH),
        child(),
      )
      .refine(
        (obj) => Object.keys(obj).length <= STRUCTURED_INPUT_MAX_OBJECT_KEYS,
        {
          message: `Structured input objects must not exceed ${STRUCTURED_INPUT_MAX_OBJECT_KEYS} keys.`,
        },
      ),
  ]);
}

/**
 * Bounded recursive schema for structured CI/CD input values.
 *
 * Pipeline inputs and schedule inputs both accept this value model.
 * The schema enforces:
 *  - maximum nesting depth of {@link STRUCTURED_INPUT_MAX_DEPTH}
 *  - maximum array length per level of {@link STRUCTURED_INPUT_MAX_ARRAY_LENGTH}
 *  - maximum object key count per level of {@link STRUCTURED_INPUT_MAX_OBJECT_KEYS}
 *  - maximum string length of {@link STRUCTURED_INPUT_MAX_STRING_LENGTH}
 *
 * The serialized form is implicitly bounded by the combination of
 * depth, array length, key count, and string length limits.
 */
export const structuredInputValue = boundedStructuredInput();
