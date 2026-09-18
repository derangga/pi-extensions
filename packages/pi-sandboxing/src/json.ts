/**
 * The JSON boundary. Everything this extension reads from disk arrives as text,
 * and `JSON.parse` hands back `any`; this is the one place that cast lives, so
 * every caller branches on a domain type instead.
 */

/** Exactly the set of shapes `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isJsonString(node: JsonValue): node is string {
  return typeof node === "string";
}

export function isJsonBoolean(node: JsonValue): node is boolean {
  return typeof node === "boolean";
}

export function isJsonArray(node: JsonValue): node is JsonValue[] {
  return Array.isArray(node);
}

export function isJsonObject(node: JsonValue): node is JsonObject {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

/** Parsed, or undefined for anything that is not JSON. Never throws. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse returns any; JsonValue is exactly the set of shapes it
    // can produce, and every consumer guards before use.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** One named string field of a JSON object, or undefined when it is absent or not a string. */
export function stringField(object: JsonObject, field: string): string | undefined {
  const value = object[field];
  return value !== undefined && isJsonString(value) ? value : undefined;
}
