// `npm run build:public` — bundle the public page into static files.
//
// The page imports the SAME pricing modules the trading runtime uses, so this
// bundles rather than duplicates. Output is plain static files: no server, no
// API keys, no build-time secrets. Both Somnia indexers send permissive CORS
// headers, so the page talks to them directly from the browser.

import { build, type Plugin } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("public");

/**
 * Let the browser bundle import the engine's config module.
 *
 * `src/core/env.ts` reads a .env file, which is right on a server and meaningless
 * in a tab, and `src/core/config.ts` layers those overrides on top of the venue
 * constants. Rather than fork config for the browser — two copies of the endpoint
 * list is exactly how a page ends up quietly pointing at the wrong venue — the
 * filesystem is stubbed and `process.env` is an empty object, so every override
 * is simply absent and the built-in constants stand.
 *
 * Scoped to `node:fs` and `node:path` on purpose. Anything else reaching for a
 * Node builtin is a real mistake and should still fail the build loudly.
 */
const nodeStub: Plugin = {
  name: "node-stub",
  setup(b) {
    b.onResolve({ filter: /^node:(fs|path)$/ }, (a) => ({ path: a.path, namespace: "node-stub" }));
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: `
        export const existsSync = () => false;
        export const readFileSync = () => "";
        export const resolve = (...p) => p.join("/");
        export default { existsSync, readFileSync, resolve };
      `,
      loader: "js",
    }));
  },
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const result = await build({
    entryPoints: ["src/public/main.ts"],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: true,
    sourcemap: false,
    outfile: resolve(OUT, "app.js"),
    // Fail loudly rather than shipping a page that half-works: anything reaching
    // for a Node builtin does not belong in the browser bundle.
    external: [],
    plugins: [nodeStub],
    // A `process` shim rather than a `define` for `process.env`.
    //
    // The narrower version shipped a broken page: defining only `process.env`
    // left `loadEnv(dir = process.cwd())` in config.ts referencing a bare
    // `process`, which throws ReferenceError in any browser the moment the
    // module loads. It typechecked, it bundled, and it was caught only by a test
    // that actually boots the bundle. A shim covers every `process.X` a
    // dependency might reach for, not the one we happened to think of.
    banner: {
      js: `globalThis.process ||= { env: {}, cwd: () => "/", argv: [], platform: "browser", version: "" };`,
    },
    logLevel: "warning",
    metafile: true,
  });

  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`bundled  public/app.js  ${(bytes / 1024).toFixed(1)} kB`);

  // The evidence the page shows is the artefact the calibration CLI writes, not
  // a hand-copied number. Ship it beside the page so the two cannot disagree.
  const artefacts = ["calibration", "backtest", "coherence", "maker-live"];
  const copied: string[] = [];
  for (const name of artefacts) {
    const from = resolve(`docs/evidence/${name}.json`);
    if (existsSync(from)) {
      copyFileSync(from, resolve(OUT, `${name}.json`));
      copied.push(name);
    } else {
      console.log(`WARNING  docs/evidence/${name}.json missing — that section will render as unavailable.`);
    }
  }
  console.log(`copied   ${copied.length} evidence artefact${copied.length === 1 ? "" : "s"}: ${copied.join(", ")}`);
  const cal = resolve("docs/evidence/calibration.json");

  // A single self-contained file, for handing to someone who should not have to
  // run a web server to look at it. Both Somnia indexers allow a `null` origin,
  // so this still fetches live data when opened straight off disk.
  const single = resolve(OUT, "rivo-public.html");
  const html = readFileSync(resolve(OUT, "index.html"), "utf8");
  const js = readFileSync(resolve(OUT, "app.js"), "utf8");
  const inlined = Object.fromEntries(
    artefacts
      .filter((n) => existsSync(resolve(`docs/evidence/${n}.json`)))
      .map((n) => [n, JSON.parse(readFileSync(resolve(`docs/evidence/${n}.json`), "utf8"))]),
  );
  writeFileSync(
    single,
    html
      .replace('<script type="module" src="app.js"></script>', `<script type="module">\n${js}\n</script>`)
      // The bundle fetches calibration.json beside itself, which has no meaning
      // for a file:// page. Serve it from memory instead.
      // The bundle fetches its evidence from files beside itself, which have no
      // meaning for a file:// page. Serve them from memory instead, so the
      // single file is genuinely self-contained rather than half-working.
      .replace(
        "</head>",
        `<script>window.__RIVO_EVIDENCE=${JSON.stringify(inlined)};\n` +
          `const _f=window.fetch;window.fetch=(u,...r)=>{\n` +
          `  const m=String(u).match(/([\\w-]+)\\.json$/);\n` +
          `  const hit=m&&window.__RIVO_EVIDENCE[m[1]];\n` +
          `  return hit?Promise.resolve({ok:true,json:()=>Promise.resolve(hit)}):_f(u,...r);\n` +
          `};</script>\n</head>`,
      ),
  );
  console.log(`wrote    public/rivo-public.html  ${(readFileSync(single).length / 1024).toFixed(1)} kB  (self-contained)`);

  console.log("");
  console.log("Static output in public/. Serve it anywhere:");
  console.log("  npx serve public          # locally");
  console.log("  GitHub Pages / Vercel / Netlify — no backend, no env vars");
}

main().catch((e) => {
  console.error(`build failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
