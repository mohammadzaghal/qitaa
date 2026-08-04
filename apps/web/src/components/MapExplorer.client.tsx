"use client";

import dynamic from "next/dynamic";

/**
 * maplibre-gl reads `window`/`document` at module scope, so it cannot be
 * evaluated during server rendering — even from a "use client" module, which
 * Next still executes on the server to produce the initial HTML.
 * This boundary defers the whole map bundle to the browser.
 */
export const MapExplorer = dynamic(
  () => import("./MapExplorer").then((m) => m.MapExplorer),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-dvh w-full place-items-center bg-basalt-950">
        <p className="animate-pulse text-sm text-sand-300/60">Loading Amman…</p>
      </div>
    ),
  },
);
