// `npm run build:public` — bundle the public page into static files.
//
// The page imports the SAME pricing modules the trading runtime uses, so this
// bundles rather than duplicates. Output is plain static files: no server, no
// API keys, no build-time secrets. Both Somnia indexers send permissive CORS
// headers, so the page talks to them directly from the browser.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("public");

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
    logLevel: "warning",
    metafile: true,
  });

  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`bundled  public/app.js  ${(bytes / 1024).toFixed(1)} kB`);

  // The evidence the page shows is the artefact the calibration CLI writes, not
  // a hand-copied number. Ship it beside the page so the two cannot disagree.
  const cal = resolve("docs/evidence/calibration.json");
  if (existsSync(cal)) {
    copyFileSync(cal, resolve(OUT, "calibration.json"));
    console.log("copied   public/calibration.json");
  } else {
    console.log("WARNING  docs/evidence/calibration.json missing — the page will render without its evidence panel.");
    console.log("         run: npm run calibrate -- --days 30 --out docs/evidence/calibration.json");
  }

  // A single self-contained file, for handing to someone who should not have to
  // run a web server to look at it. Both Somnia indexers allow a `null` origin,
  // so this still fetches live data when opened straight off disk.
  const single = resolve(OUT, "rivo-public.html");
  const html = readFileSync(resolve(OUT, "index.html"), "utf8");
  const js = readFileSync(resolve(OUT, "app.js"), "utf8");
  const evidence = existsSync(cal) ? readFileSync(cal, "utf8") : "null";
  writeFileSync(
    single,
    html
      .replace('<script type="module" src="app.js"></script>', `<script type="module">\n${js}\n</script>`)
      // The bundle fetches calibration.json beside itself, which has no meaning
      // for a file:// page. Serve it from memory instead.
      .replace(
        "</head>",
        `<script>window.__RIVO_EVIDENCE=${evidence};\n` +
          `const _f=window.fetch;window.fetch=(u,...r)=>String(u).endsWith("calibration.json")\n` +
          `  ? Promise.resolve({ok:!!window.__RIVO_EVIDENCE,json:()=>Promise.resolve(window.__RIVO_EVIDENCE)})\n` +
          `  : _f(u,...r);</script>\n</head>`,
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
