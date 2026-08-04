"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ParcelProps } from "@/lib/types";
import { InvestPanel } from "./InvestPanel";
import { Legend } from "./Legend";

const BASEMAP =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";

// Terrarium-encoded global DEM (Mapzen/AWS open data) — free, no key, and the
// only practical way to show Amman's wadi topography without hosting our own.
const TERRAIN_DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const AMMAN = { lng: 35.8783, lat: 31.9539 };

export function MapExplorer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [selected, setSelected] = useState<ParcelProps | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"invest" | "market" | "gap">("invest");

  // pmtiles:// protocol must be registered before any map instance is created.
  useEffect(() => {
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    return () => maplibregl.removeProtocol("pmtiles");
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP,
      center: [AMMAN.lng, AMMAN.lat],
      zoom: 14.5,
      pitch: 62,
      bearing: -22,
      maxPitch: 85,
      canvasContextAttributes: { antialias: true },
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", async () => {
      try {
      // ---- terrain ------------------------------------------------------
      map.addSource("dem", {
        type: "raster-dem",
        tiles: [TERRAIN_DEM],
        tileSize: 256,
        maxzoom: 14,
        encoding: "terrarium",
        attribution: "Elevation © Mapzen / AWS Open Data",
      });
      map.setTerrain({ source: "dem", exaggeration: 1.25 });
      map.addLayer({
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        paint: { "hillshade-exaggeration": 0.35 },
      });
      map.setSky({
        "sky-color": "#0d1b2a",
        "horizon-color": "#3d4a5c",
        "fog-color": "#0a0c10",
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.5,
      });

      // ---- generic 3D massing from the basemap's building layer ---------
      // OpenFreeMap Liberty ships an OMT `building` source-layer. We extrude it
      // as context, then overlay our own cadastral prisms on top.
      if (map.getSource("openmaptiles")) {
        map.addLayer({
          id: "context-buildings",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": "#252a33",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.75,
          },
        });
      }

      // ---- cadastral parcels -------------------------------------------
      const res = await fetch("/data/amman-parcels.geojson");
      if (!res.ok) {
        throw new Error(
          `Could not load /data/amman-parcels.geojson (HTTP ${res.status}). ` +
            `Run \`node scripts/gen-parcels.mjs\` from the repo root.`,
        );
      }
      const parcels = await res.json();
      map.addSource("parcels", { type: "geojson", data: parcels, promoteId: "id" });

      map.addLayer({
        id: "parcels-3d",
        type: "fill-extrusion",
        source: "parcels",
        paint: {
          "fill-extrusion-color": colorExpression("invest"),
          "fill-extrusion-height": ["+", ["get", "height_m"], 2],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.88,
          "fill-extrusion-vertical-gradient": true,
        },
      });

      map.addLayer({
        id: "parcels-outline",
        type: "line",
        source: "parcels",
        paint: {
          "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#f2ede4", "#3a4150"],
          "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.2, 0.6],
        },
      });

      let hovered: string | number | undefined;
      map.on("mousemove", "parcels-3d", (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f) return;
        if (hovered !== undefined) map.setFeatureState({ source: "parcels", id: hovered }, { hover: false });
        hovered = f.id;
        map.setFeatureState({ source: "parcels", id: hovered! }, { hover: true });
      });
      map.on("mouseleave", "parcels-3d", () => {
        map.getCanvas().style.cursor = "";
        if (hovered !== undefined) map.setFeatureState({ source: "parcels", id: hovered }, { hover: false });
        hovered = undefined;
      });

      map.on("click", "parcels-3d", (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as Record<string, unknown>;
        setSelected(hydrate(props));
        map.easeTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 16.5), pitch: 65, duration: 700 });
      });

      setReady(true);
      } catch (err) {
        console.error("[qitaa] map init failed", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    map.on("error", (e) => {
      // Style/tile fetch failures arrive here, not as thrown exceptions.
      console.error("[qitaa] maplibre error", e.error ?? e);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const applyMode = useCallback((next: typeof mode) => {
    setMode(next);
    const map = mapRef.current;
    if (map?.getLayer("parcels-3d")) {
      map.setPaintProperty("parcels-3d", "fill-extrusion-color", colorExpression(next));
    }
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <div className="pointer-events-auto rounded-xl bg-basalt-900/85 px-4 py-3 backdrop-blur">
          <h1 className="text-lg font-semibold tracking-tight">
            قطعة <span className="text-petra-400">Qitaa</span>
          </h1>
          <p className="text-xs text-sand-300/70">Own a piece of Jordan — from 300 JD</p>
        </div>
        <div className="pointer-events-auto flex gap-1 rounded-xl bg-basalt-900/85 p-1 backdrop-blur">
          {(["invest", "market", "gap"] as const).map((m) => (
            <button
              key={m}
              onClick={() => applyMode(m)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                mode === m ? "bg-petra-500 text-white" : "text-sand-300/70 hover:text-sand-100"
              }`}
            >
              {m === "gap" ? "value gap" : m}
            </button>
          ))}
        </div>
      </header>

      <Legend mode={mode} />

      {!ready && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-basalt-950 p-8">
          {error ? (
            <div className="max-w-md text-center">
              <p className="text-sm font-semibold text-petra-400">Map failed to load</p>
              <p className="mt-2 text-xs leading-relaxed text-sand-300/60">{error}</p>
              <p className="mt-3 text-[11px] text-sand-300/40">
                Full details are in the browser console.
              </p>
            </div>
          ) : (
            <p className="animate-pulse text-sm text-sand-300/60">Loading Amman…</p>
          )}
        </div>
      )}

      {selected && <InvestPanel parcel={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

/**
 * Three ways to read the same city:
 *  - invest: is there a live offering, and how full is it
 *  - market: asking price per m²
 *  - gap:    market price vs. the DLS administrative value. A wide gap is where
 *            transfer-fee exposure and mispricing both live.
 */
function colorExpression(mode: "invest" | "market" | "gap"): maplibregl.ExpressionSpecification {
  if (mode === "market") {
    return [
      "interpolate", ["linear"], ["get", "market_value_fils_m2"],
      150_000, "#2c3340",
      400_000, "#5c6b8a",
      800_000, "#c96a44",
      1_500_000, "#f0a071",
    ];
  }
  if (mode === "gap") {
    return [
      "interpolate", ["linear"],
      ["/", ["get", "market_value_fils_m2"], ["max", ["get", "admin_value_fils_m2"], 1]],
      1.0, "#2c3340",
      1.6, "#5c6b8a",
      2.4, "#c96a44",
      3.5, "#ff7a45",
    ];
  }
  return [
    "case",
    ["==", ["get", "offering_id"], ""], "#2c3340",
    [
      "interpolate", ["linear"],
      ["/", ["get", "units_sold"], ["max", ["get", "units_offered"], 1]],
      0, "#3f7d6a",
      0.5, "#8fae54",
      0.9, "#e0855f",
      1, "#c96a44",
    ],
  ];
}

/** MapLibre flattens nested GeoJSON properties to strings — rebuild the shape. */
function hydrate(p: Record<string, unknown>): ParcelProps {
  const n = (k: string) => Number(p[k] ?? 0);
  return {
    id: String(p.id),
    dls: { village: n("dls_village"), basin: n("dls_basin"), plot: n("dls_plot") },
    neighbourhood_en: String(p.neighbourhood_en ?? ""),
    neighbourhood_ar: String(p.neighbourhood_ar ?? ""),
    type: (p.type as ParcelProps["type"]) ?? "land",
    area_m2: n("area_m2"),
    admin_value_fils_m2: n("admin_value_fils_m2"),
    market_value_fils_m2: n("market_value_fils_m2"),
    height_m: n("height_m"),
    offering: p.offering_id
      ? {
          id: String(p.offering_id),
          spv_name: String(p.spv_name ?? ""),
          unit_price_fils: n("unit_price_fils"),
          units_offered: n("units_offered"),
          units_sold: n("units_sold"),
          target_net_yield_bps: n("target_net_yield_bps"),
          closes_at: String(p.closes_at ?? ""),
        }
      : null,
  };
}
