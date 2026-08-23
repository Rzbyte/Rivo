// Finding the .sql files, which is not the same problem under Node and under a
// bundler — and the difference cost a production deploy.

import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrationsDir } from "./migrate.js";

describe("locating the migrations", () => {
  it("returns a directory that exists and holds .sql files", () => {
    // The previous implementation derived a path from import.meta.url and never
    // checked it. Webpack inlines that to the path the BUILD ran at, so a
    // serverless function looked for /vercel/path0/src/db/migrations and threw
    // ENOENT — which surfaced as /api/health reporting "the database did not
    // answer" while the database was answering perfectly.
    const dir = migrationsDir();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).length).toBeGreaterThan(0);
  });

  it("names every candidate and the cwd when it finds nothing", () => {
    // The error it replaced named exactly one path, and that path was the one
    // guaranteed to be wrong. Whoever reads this next needs the alternatives.
    const src = migrationsDir.toString();
    expect(src).toMatch(/no migrations directory found/);
    expect(src).toMatch(/candidates\.join/);
    expect(src).toMatch(/process\.cwd\(\)/);
  });

  it("loads every migration in lexical order, with a checksum", () => {
    // Order is the schema's history; a set would be a different database.
    const all = loadMigrations();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((m) => m.name)).toEqual([...all.map((m) => m.name)].sort());
    for (const m of all) {
      expect(m.name).toMatch(/\.sql$/);
      expect(m.sql.length).toBeGreaterThan(0);
      expect(m.checksum).toMatch(/^[0-9a-f]{8,}$/);
    }
  });
});
