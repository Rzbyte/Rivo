/** @type {import('next').NextConfig} */
const config = {
  // The web app imports the engine's types and the durable layer straight from
  // `src/`, rather than through a published package. There is one definition of
  // a portfolio policy, one of a decision record, and one set of SQL — which is
  // the entire reason this is a workspace and not two repositories.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
  transpilePackages: [],
  eslint: {
    // Lint is a separate command, not a build gate. A type error should fail a
    // deploy; an unused import should not.
    ignoreDuringBuilds: true,
  },
  webpack: (cfg) => {
    // The engine is NodeNext ESM: its relative imports carry `.js` extensions
    // that resolve to `.ts` on disk. Webpack needs telling, or every shared
    // import fails to resolve with a message that names the `.js` file nobody
    // wrote.
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return cfg;
  },
};

export default config;
