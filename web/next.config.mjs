/** @type {import('next').NextConfig} */
const config = {
  // The web app imports the engine's types and the durable layer straight from
  // `src/`, rather than through a published package. There is one definition of
  // a portfolio policy, one of a decision record, and one set of SQL — which is
  // the entire reason this is a workspace and not two repositories.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,

  webpack: (cfg) => {
    // The engine is NodeNext ESM: its relative imports carry `.js` extensions
    // that resolve to `.ts` on disk. Webpack needs telling, or every shared
    // import fails to resolve with a message that names a `.js` file nobody
    // wrote.
    //
    // This is why the build passes `--webpack` explicitly (see package.json).
    // Next 16 defaults to Turbopack, which has no equivalent of `extensionAlias`
    // and cannot resolve those imports — measured, not assumed: switching to it
    // fails on every `@rivo/*` import in the app. The alternative would be to
    // rewrite seventeen thousand lines of engine imports to suit a bundler that
    // only the web tier uses, which is the wrong way round.
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return cfg;
  },
};

export default config;
