import type { ColorName } from "../../colors.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** Drops undefined keys, which exactOptionalPropertyTypes rejects on a style object. */
export function colorPair(
  fg: ColorName | undefined,
  bg: ColorName | undefined,
) {
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
  };
}
