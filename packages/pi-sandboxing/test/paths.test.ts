import { describe, expect, it } from "vitest";
import { normalizeToolPath } from "../src/paths.js";

describe("tool path normalization", () => {
  it("matches Pi's Windows shell-path conversion", () => {
    expect(normalizeToolPath("/c/work/.env", "win32")).toBe("C:\\work\\.env");
    expect(normalizeToolPath("/mnt/d/work/.env", "win32")).toBe("D:\\work\\.env");
    expect(normalizeToolPath("/cygdrive/e/work/.env", "win32")).toBe("E:\\work\\.env");
  });

  it("leaves native and POSIX paths alone", () => {
    expect(normalizeToolPath("C:\\work\\.env", "win32")).toBe("C:\\work\\.env");
    expect(normalizeToolPath("/work/.env", "darwin")).toBe("/work/.env");
  });
});
