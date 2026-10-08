import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tailwind 4 compiles through the Turbopack CSS loader. Turbopack is the
  // default bundler in Next 16 for both `next dev` and `next build`.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // NOTE: `cacheComponents` / `partialPrefetching` were enabled by the
  // scaffold and are deliberately disabled.
  //
  // Every route in AdhikarAI renders per-citizen, live benefit state. A
  // cached shell showing a stale payment or receipt status would contradict
  // the core product guarantee (see docs/specs: the four-way distinction
  // between expected / reported / claimed / proven). Dynamic-by-default with
  // no prerendered shell is the correct trade here; revisit only if a
  // genuinely static surface appears.
};

export default nextConfig;
