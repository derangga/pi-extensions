import { describe, expect, it } from "vitest";
import type { Needle } from "../src/harvest.js";
import { activeCount, burnOrigin, createStore, redact, refreshOrigin } from "../src/redact.js";

function needle(value: string, label: string, origin = ".env"): Needle {
  return { value, label, origin };
}

const dbPass = needle("hunter2supersecret", "DB_PASS");
const apiKey = needle("averylongapikeyvalue", "API_KEY");

describe("redacting", () => {
  it("replaces a needle with a placeholder naming its label", () => {
    const store = createStore([dbPass]);
    expect(redact(store, "DB_PASS=hunter2supersecret").text).toBe("DB_PASS=[redacted: DB_PASS]");
  });

  it("replaces every occurrence, not just the first", () => {
    const store = createStore([dbPass]);
    const result = redact(store, "hunter2supersecret and again hunter2supersecret");
    expect(result.text).toBe("[redacted: DB_PASS] and again [redacted: DB_PASS]");
  });

  it("catches a needle glued into a connection string", () => {
    const store = createStore([dbPass]);
    const result = redact(store, "postgres://app:hunter2supersecret@db:5432/app");
    expect(result.text).toBe("postgres://app:[redacted: DB_PASS]@db:5432/app");
  });

  it("takes the longest needle first so no fragment survives", () => {
    // The short needle sits inside the long one. Replacing it first would leave
    // "def" of the longer secret in the output.
    const store = createStore([needle("abc123", "SHORT"), needle("abc123def", "LONG")]);
    expect(redact(store, "abc123def").text).toBe("[redacted: LONG]");
  });

  it("over-matches rather than under-matches", () => {
    // Documented behaviour: a mangled log line costs a squint, a missed secret
    // costs the secret.
    const store = createStore([needle("postgres1user", "DB_USER")]);
    expect(redact(store, "postgres1user99 is the tag").text).toBe(
      "[redacted: DB_USER]99 is the tag",
    );
  });

  it("reports each label it hit, once", () => {
    const store = createStore([dbPass, apiKey]);
    const result = redact(store, "hunter2supersecret hunter2supersecret averylongapikeyvalue");
    expect(result.labels.sort()).toEqual(["API_KEY", "DB_PASS"]);
  });

  it("leaves text with no needles exactly as it was", () => {
    const store = createStore([dbPass]);
    const result = redact(store, "nothing secret here");
    expect(result.text).toBe("nothing secret here");
    expect(result.labels).toEqual([]);
  });

  it("is the identity when nothing has been harvested", () => {
    expect(redact(createStore([]), "anything at all").text).toBe("anything at all");
  });
});

describe("burning", () => {
  it("stops redacting every needle from an approved file", () => {
    const store = createStore([dbPass, apiKey, needle("thirdpartytoken", "TOKEN", ".npmrc")]);
    burnOrigin(store, ".env");
    const result = redact(store, "hunter2supersecret averylongapikeyvalue thirdpartytoken");
    expect(result.text).toBe("hunter2supersecret averylongapikeyvalue [redacted: TOKEN]");
  });

  it("reports the labels it burned", () => {
    const store = createStore([dbPass, apiKey]);
    expect(burnOrigin(store, ".env").sort()).toEqual(["API_KEY", "DB_PASS"]);
  });

  it("burns nothing for a file it never harvested", () => {
    const store = createStore([dbPass]);
    expect(burnOrigin(store, "other.env")).toEqual([]);
    expect(redact(store, "hunter2supersecret").labels).toEqual(["DB_PASS"]);
  });

  it("keeps a value burned even when the same file is harvested again", () => {
    // Once the model holds a value, redacting its echo protects nothing.
    const store = createStore([dbPass]);
    burnOrigin(store, ".env");
    refreshOrigin(store, ".env", [dbPass, apiKey]);
    const result = redact(store, "hunter2supersecret averylongapikeyvalue");
    expect(result.text).toBe("hunter2supersecret [redacted: API_KEY]");
  });
});

describe("re-harvesting one file", () => {
  it("replaces that file's needles and leaves the others", () => {
    const other = needle("thirdpartytoken", "TOKEN", ".npmrc");
    const store = createStore([dbPass, other]);
    refreshOrigin(store, ".env", [needle("rotatedtoanewvalue", "DB_PASS")]);
    const result = redact(store, "hunter2supersecret rotatedtoanewvalue thirdpartytoken");
    expect(result.text).toBe("hunter2supersecret [redacted: DB_PASS] [redacted: TOKEN]");
  });

  it("counts the needles it is holding", () => {
    const store = createStore([dbPass, apiKey]);
    expect(activeCount(store)).toBe(2);
    burnOrigin(store, ".env");
    expect(activeCount(store)).toBe(0);
  });
});
