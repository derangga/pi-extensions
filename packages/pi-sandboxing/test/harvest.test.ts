import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractNeedles, harvest, harvestFile, passesNoiseFloor } from "../src/harvest.js";
import { mergeLayers } from "../src/rules.js";

const home = homedir();
const rules = mergeLayers({ global: {}, project: {}, projectTrusted: true });

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-sandboxing-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

describe("the noise floor", () => {
  it("keeps a value long enough to be a credential", () => {
    expect(passesNoiseFloor("hunter2supersecret", new Set())).toBe(true);
  });

  it("drops anything shorter than eight characters", () => {
    expect(passesNoiseFloor("abc123", new Set())).toBe(false);
    expect(passesNoiseFloor("Tr0ub4do", new Set())).toBe(true);
  });

  it("drops pure digits, however long", () => {
    expect(passesNoiseFloor("3000", new Set())).toBe(false);
    expect(passesNoiseFloor("1234567890123", new Set())).toBe(false);
  });

  it("drops the words that fill every dotenv file", () => {
    for (const word of ["development", "production", "localhost", "postgres"]) {
      expect(passesNoiseFloor(word, new Set())).toBe(false);
    }
  });

  it("ignores case when matching the stoplist", () => {
    expect(passesNoiseFloor("DEVELOPMENT", new Set())).toBe(false);
  });

  it("accepts extra stoplist words from the config", () => {
    expect(passesNoiseFloor("mycompanyname", new Set(["mycompanyname"]))).toBe(false);
  });
});

describe("dotenv extraction", () => {
  it("labels each value with its key", () => {
    const needles = extractNeedles(".env", "DB_PASS=hunter2supersecret\n");
    expect(needles).toEqual([{ value: "hunter2supersecret", label: "DB_PASS" }]);
  });

  it("strips quotes of either kind", () => {
    expect(extractNeedles(".env", `A="hunter2supersecret"\n`)[0]?.value).toBe("hunter2supersecret");
    expect(extractNeedles(".env", `A='hunter2supersecret'\n`)[0]?.value).toBe("hunter2supersecret");
  });

  it("handles an export prefix", () => {
    expect(extractNeedles(".env", "export DB_PASS=hunter2supersecret\n")[0]?.label).toBe("DB_PASS");
  });

  it("skips comments, blanks and keys with no value", () => {
    const needles = extractNeedles(
      ".env",
      "# a comment\n\nEMPTY=\nDB_PASS=hunter2supersecret\n  # indented comment\n",
    );
    expect(needles).toEqual([{ value: "hunter2supersecret", label: "DB_PASS" }]);
  });

  it("keeps a value containing an equals sign intact", () => {
    expect(extractNeedles(".env", "TOKEN=abc==def==ghi\n")[0]?.value).toBe("abc==def==ghi");
  });

  it("reads an npmrc the same way", () => {
    const needles = extractNeedles(
      ".npmrc",
      "//registry.npmjs.org/:_authToken=npm_averylongtoken\n",
    );
    expect(needles[0]?.value).toBe("npm_averylongtoken");
  });
});

describe("json extraction", () => {
  it("labels a string leaf with the file and its key path", () => {
    const needles = extractNeedles(
      "credentials.json",
      JSON.stringify({ client_secret: "hunter2supersecret" }),
    );
    expect(needles).toEqual([
      { value: "hunter2supersecret", label: "credentials.json:client_secret" },
    ]);
  });

  it("line-splits a pem held inside a string leaf", () => {
    // A service account key arrives as one JSON string. Truncated output shows
    // part of it, so the body lines have to be needles of their own.
    const key =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\nOTHERLINEOFBASE64DATA==\n-----END PRIVATE KEY-----";
    const values = extractNeedles("credentials.json", JSON.stringify({ private_key: key })).map(
      (needle) => needle.value,
    );
    expect(values).toContain(key);
    expect(values).toContain("MIIEvQIBADANBgkqhkiG9w0BAQ");
    expect(values).toContain("OTHERLINEOFBASE64DATA==");
  });

  it("walks nested objects and arrays", () => {
    const needles = extractNeedles(
      "service-account.json",
      JSON.stringify({ auth: { keys: ["firstlongsecret", "secondlongsecret"] } }),
    );
    expect(needles.map((needle) => needle.label)).toEqual([
      "service-account.json:auth.keys.0",
      "service-account.json:auth.keys.1",
    ]);
  });

  it("falls back to line parsing when the json is malformed", () => {
    // A half-written file must not throw the whole harvest away.
    expect(() => extractNeedles("credentials.json", "{ not json")).not.toThrow();
  });
});

describe("pem extraction", () => {
  const pem = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
    "AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1",
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");

  it("takes each body line so truncated output still matches", () => {
    const values = extractNeedles("certs/id_ed25519", pem).map((needle) => needle.value);
    expect(values).toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
    expect(values).toContain("AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1");
  });

  it("takes the whole body as one needle too", () => {
    const values = extractNeedles("certs/id_ed25519", pem).map((needle) => needle.value);
    expect(values).toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1");
  });

  it("labels every needle with the file, since a pem has no keys", () => {
    for (const needle of extractNeedles("certs/id_ed25519", pem)) {
      expect(needle.label).toBe("certs/id_ed25519");
    }
  });

  it("leaves the armour markers out of the needles", () => {
    const values = extractNeedles("certs/id_ed25519", pem).map((needle) => needle.value);
    expect(values).not.toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
  });
});

describe("the walk", () => {
  it("harvests every rule-matching file in the tree", () => {
    write(".env", "DB_PASS=hunter2supersecret\n");
    write(
      "certs/dev.pem",
      "-----BEGIN CERTIFICATE-----\nZGV2Y2VydGlmaWNhdGVib2R5\n-----END CERTIFICATE-----\n",
    );
    const needles = harvest(root, rules, home, new Set());
    expect(needles.map((needle) => needle.value)).toContain("hunter2supersecret");
    expect(needles.map((needle) => needle.value)).toContain("ZGV2Y2VydGlmaWNhdGVib2R5");
  });

  it("leaves example files out", () => {
    write(".env.example", "DB_PASS=changemeplease\n");
    expect(harvest(root, rules, home, new Set())).toEqual([]);
  });

  it("does not descend into .git or node_modules", () => {
    write(".git/.env", "GIT_SECRET=hunter2supersecret\n");
    write("node_modules/pkg/.env", "DEP_SECRET=hunter2supersecret\n");
    expect(harvest(root, rules, home, new Set())).toEqual([]);
  });

  it("skips a file too large to be a config file", () => {
    write("big.pem", "x".repeat(1024 * 1024 + 1));
    expect(harvest(root, rules, home, new Set())).toEqual([]);
  });

  it("skips a file that is not text", () => {
    writeFileSync(join(root, "blob.key"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    expect(harvest(root, rules, home, new Set())).toEqual([]);
  });

  it("never reads outside the workspace, even for a home rule", () => {
    // ~/.ssh is jailed by the profile and gated by the dialog. Reading it to
    // protect it would put every key the user owns into this process.
    const needles = harvest(root, rules, home, new Set());
    expect(needles.every((needle) => !needle.label.startsWith(home))).toBe(true);
  });
});

describe("re-harvesting one file", () => {
  it("returns the values as they are now", () => {
    write(".env", "DB_PASS=hunter2supersecret\n");
    expect(harvestFile(join(root, ".env"), root, new Set())[0]?.value).toBe("hunter2supersecret");
    write(".env", "DB_PASS=rotatedtoanewvalue\n");
    expect(harvestFile(join(root, ".env"), root, new Set())[0]?.value).toBe("rotatedtoanewvalue");
  });

  it("returns nothing for a file that has been deleted", () => {
    expect(harvestFile(join(root, "gone.env"), root, new Set())).toEqual([]);
  });
});
