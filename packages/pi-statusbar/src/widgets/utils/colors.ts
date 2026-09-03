import type { ColorName } from "../../colors.js";

/** Drops undefined keys, which exactOptionalPropertyTypes rejects on a style object. */
export function colorPair(
  fg: ColorName | undefined,
  bg: ColorName | undefined,
): { fg?: ColorName; bg?: ColorName } {
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
  };
}
