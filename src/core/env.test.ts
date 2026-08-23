// Finding `.env`.
//
// This was one directory deep, which was enough while everything ran from the
// repository root and stopped being enough the moment the web app existed:
// Next.js runs with its own directory as the cwd, looked for `web/.env`, found
// nothing, and reported "no DATABASE_URL configured" on a machine whose `.env`
// had one — with nothing anywhere pointing at the reason.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEnvFile } from "./env.js";

let root: string;
const saved = process.env.RIVO_ENV_FILE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rivo-env-"));
  delete process.env.RIVO_ENV_FILE;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.RIVO_ENV_FILE;
  else process.env.RIVO_ENV_FILE = saved;
});

describe("finding the file", () => {
  it("finds one in the directory it is given", () => {
    writeFileSync(join(root, ".env"), "A=1");
    expect(findEnvFile(root)).toBe(join(root, ".env"));
  });

  it("walks up to the repository root — the regression", () => {
    // Exactly the shape that broke: config at the root, process running in a
    // subdirectory.
    writeFileSync(join(root, ".env"), "DATABASE_URL=x");
    const web = join(root, "web");
    mkdirSync(web);
    expect(findEnvFile(web)).toBe(join(root, ".env"));
  });

  it("prefers the nearest one when both exist", () => {
    writeFileSync(join(root, ".env"), "A=root");
    const web = join(root, "web");
    mkdirSync(web);
    writeFileSync(join(web, ".env"), "A=web");
    expect(findEnvFile(web)).toBe(join(web, ".env"));
  });

  it("returns null rather than guessing when there is none", () => {
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(findEnvFile(deep)).toBeNull();
  });

  it("stops climbing, so it cannot adopt a stranger's file", () => {
    // Six levels is deep enough for any monorepo and shallow enough that a
    // process started somewhere unexpected does not wander into a home
    // directory and read whatever it finds.
    writeFileSync(join(root, ".env"), "A=1");
    const deep = join(root, "1", "2", "3", "4", "5", "6", "7");
    mkdirSync(deep, { recursive: true });
    expect(findEnvFile(deep)).toBeNull();
  });

  it("takes an absolute RIVO_ENV_FILE literally", () => {
    const custom = join(root, "custom.env");
    writeFileSync(custom, "A=1");
    process.env.RIVO_ENV_FILE = custom;
    // Not searched for, and not resolved relative to anything.
    expect(findEnvFile(join(root, "elsewhere"))).toBe(custom);
  });

  it("searches for a relative RIVO_ENV_FILE by name", () => {
    writeFileSync(join(root, "staging.env"), "A=1");
    process.env.RIVO_ENV_FILE = "staging.env";
    const web = join(root, "web");
    mkdirSync(web);
    expect(findEnvFile(web)).toBe(join(root, "staging.env"));
  });
});
