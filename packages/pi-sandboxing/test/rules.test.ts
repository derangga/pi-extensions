import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_RULES,
  gatedArgument,
  matchRule,
  mergeLayers,
  type RuleLayer,
} from "../src/rules.js";

const cwd = "/repo";
const home = homedir();

const empty: RuleLayer = {};

function builtins() {
  return mergeLayers({ global: empty, project: empty, projectTrusted: true });
}

describe("builtin rules", () => {
  it("gates a dotenv file and names the glob that caught it", () => {
    const rule = matchRule(join(cwd, ".env"), builtins(), cwd, home);
    expect(rule?.glob).toBe(".env");
    expect(rule?.source).toBe("builtin");
  });

  it("gates dotenv variants through the wildcard", () => {
    for (const name of [".env.local", ".env.production", ".env.test.local"]) {
      expect(matchRule(join(cwd, name), builtins(), cwd, home)?.glob).toBe(".env.*");
    }
  });

  it("gates keys and certificates anywhere in the tree", () => {
    expect(matchRule(join(cwd, "certs/dev.pem"), builtins(), cwd, home)?.glob).toBe("*.pem");
    expect(matchRule(join(cwd, "deep/nest/app.key"), builtins(), cwd, home)?.glob).toBe("*.key");
  });

  it("gates an ssh key by prefix, with or without a suffix", () => {
    expect(matchRule(join(cwd, "id_rsa"), builtins(), cwd, home)?.glob).toBe("id_rsa*");
    expect(matchRule(join(cwd, "id_rsa.pub"), builtins(), cwd, home)?.glob).toBe("id_rsa*");
  });

  it("gates a whole home credential directory", () => {
    // Files the filename globs cannot claim, so only the directory rule can.
    expect(matchRule(join(home, ".ssh/known_hosts"), builtins(), cwd, home)?.glob).toBe("~/.ssh/");
    expect(matchRule(join(home, ".aws/credentials"), builtins(), cwd, home)?.glob).toBe("~/.aws/");
    expect(matchRule(join(home, ".gnupg/pubring.kbx"), builtins(), cwd, home)?.glob).toBe(
      "~/.gnupg/",
    );
    expect(matchRule(join(home, ".cargo/credentials.toml"), builtins(), cwd, home)?.glob).toBe(
      "~/.cargo/credentials*",
    );
  });

  it("still gates a key inside a credential directory, by whichever glob is narrower", () => {
    // id_ed25519* is listed before ~/.ssh/, so it reports first. Either answer
    // blocks the call; the narrower one tells the user more.
    expect(matchRule(join(home, ".ssh/id_ed25519"), builtins(), cwd, home)?.glob).toBe(
      "id_ed25519*",
    );
  });

  it("leaves ordinary source files alone", () => {
    expect(matchRule(join(cwd, "src/app.ts"), builtins(), cwd, home)).toBeUndefined();
    expect(matchRule(join(cwd, "package.json"), builtins(), cwd, home)).toBeUndefined();
  });
});

describe("example suffixes", () => {
  it("excludes a dotenv example even though .env.* would catch it", () => {
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
      expect(matchRule(join(cwd, name), builtins(), cwd, home)).toBeUndefined();
    }
  });

  it("excludes any file whose name ends in a documented example suffix", () => {
    expect(matchRule(join(cwd, "credentials.json.example"), builtins(), cwd, home)).toBeUndefined();
    expect(
      matchRule(join(cwd, "service-account.json.template"), builtins(), cwd, home),
    ).toBeUndefined();
  });

  it("keeps an explicit configured rule for an example file", () => {
    const rules = mergeLayers({
      global: { rules: [".env.example"] },
      project: empty,
      projectTrusted: true,
    });
    expect(matchRule(join(cwd, ".env.example"), rules, cwd, home)?.source).toBe("global");
  });
});

describe("layering", () => {
  it("matches a configured filesystem-root directory", () => {
    expect(matchRule("/tmp/value", [{ glob: "/", source: "global" }], cwd, home)?.glob).toBe("/");
  });

  it("adds rules from either layer", () => {
    const rules = mergeLayers({
      global: { rules: ["*.jks"] },
      project: { rules: ["secrets/**"] },
      projectTrusted: true,
    });
    expect(matchRule(join(cwd, "app.jks"), rules, cwd, home)?.source).toBe("global");
    expect(matchRule(join(cwd, "secrets/db/password.txt"), rules, cwd, home)?.source).toBe(
      "project",
    );
  });

  it("honours unguard in the global layer", () => {
    const rules = mergeLayers({
      global: { unguard: [".npmrc"] },
      project: empty,
      projectTrusted: true,
    });
    expect(matchRule(join(cwd, ".npmrc"), rules, cwd, home)).toBeUndefined();
  });

  it("ignores unguard in the project layer", () => {
    // A repository must not be able to un-gate itself by shipping a config.
    const rules = mergeLayers({
      global: empty,
      project: { unguard: [".env"] },
      projectTrusted: true,
    });
    expect(matchRule(join(cwd, ".env"), rules, cwd, home)?.glob).toBe(".env");
  });

  it("skips the project layer entirely for an untrusted checkout", () => {
    const rules = mergeLayers({
      global: empty,
      project: { rules: ["secrets/**"] },
      projectTrusted: false,
    });
    expect(matchRule(join(cwd, "secrets/db.txt"), rules, cwd, home)).toBeUndefined();
  });

  it("keeps one rule per glob when both layers name the same one", () => {
    const rules = mergeLayers({
      global: { rules: ["*.jks"] },
      project: { rules: ["*.jks"] },
      projectTrusted: true,
    });
    expect(rules.filter((rule) => rule.glob === "*.jks")).toHaveLength(1);
  });
});

describe("gated tools", () => {
  it("names the path argument of every gated built-in", () => {
    for (const tool of ["read", "edit", "write", "grep", "find"]) {
      expect(gatedArgument(tool, new Map())).toBe("path");
    }
  });

  it("leaves ls ungated", () => {
    expect(gatedArgument("ls", new Map())).toBeUndefined();
  });

  it("gates fff's tools under both of its naming modes", () => {
    expect(gatedArgument("ffgrep", new Map())).toBe("path");
    expect(gatedArgument("fff-multi-grep", new Map())).toBe("path");
  });

  it("accepts an extra tool from the config", () => {
    expect(gatedArgument("some_tool", new Map([["some_tool", "file_path"]]))).toBe("file_path");
  });

  it("does not let configuration replace a builtin path argument", () => {
    expect(gatedArgument("read", new Map([["read", "unused_field"]]))).toBe("path");
  });
});

describe("the builtin list itself", () => {
  it("covers the credential files the README promises", () => {
    expect(BUILTIN_RULES).toEqual([
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "id_rsa*",
      "id_ed25519*",
      "credentials.json",
      "service-account*.json",
      ".npmrc",
      ".netrc",
      "~/.aws/",
      "~/.ssh/",
      "~/.gnupg/",
      "~/.cargo/credentials*",
      "~/.docker/",
      "~/.kube/",
      "~/.config/gcloud/",
      "~/.config/gh/",
      "~/.azure/",
    ]);
  });
});
