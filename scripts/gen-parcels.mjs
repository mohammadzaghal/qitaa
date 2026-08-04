/**
 * Generates a synthetic-but-plausible cadastral fixture for the demo:
 * ~420 parcels across six real Amman neighbourhoods, addressed in the DLS
 * village/basin/plot scheme and priced against published 2025-26 asking ranges.
 *
 * Replace this with the real ingest (infra/tiles/build-tiles.sh + a DLS data
 * agreement) before anything touches production.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const HOODS = [
  { en: "Abdoun",       ar: "عبدون",        c: [35.8790, 31.9310], village: 10, basin: 21, mkt: 1_250_000, admin: 430_000, h: [9, 16],  types: ["villa","apartment"] },
  { en: "Jabal Amman",  ar: "جبل عمان",     c: [35.9250, 31.9500], village: 3,  basin: 7,  mkt:   780_000, admin: 300_000, h: [10, 22], types: ["apartment","building"] },
  { en: "Khalda",       ar: "خلدا",         c: [35.8450, 31.9800], village: 14, basin: 33, mkt:   640_000, admin: 250_000, h: [12, 26], types: ["apartment","villa"] },
  { en: "Dabouq",       ar: "دابوق",        c: [35.8050, 31.9950], village: 18, basin: 41, mkt:   520_000, admin: 190_000, h: [6, 12],  types: ["villa","land"] },
  { en: "Marj Al Hamam",ar: "مرج الحمام",   c: [35.8300, 31.8900], village: 22, basin: 55, mkt:   310_000, admin: 130_000, h: [7, 14],  types: ["land","villa"] },
  { en: "Al Jubaiha",   ar: "الجبيهة",      c: [35.8880, 32.0180], village: 8,  basin: 12, mkt:   410_000, admin: 175_000, h: [12, 24], types: ["apartment","building"] },
];

// deterministic PRNG so the fixture is reproducible in CI
let seed = 0x51744a;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const between = (a, b) => a + rnd() * (b - a);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const features = [];
let plot = 100;

for (const h of HOODS) {
  const cols = 8, rows = 9;
  const cell = 0.00085;                       // ~75 m at this latitude
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rnd() < 0.12) continue;             // streets / gaps
      const lng = h.c[0] + (i - cols / 2) * cell * 1.15;
      const lat = h.c[1] + (j - rows / 2) * cell;
      const w = cell * between(0.55, 0.9);
      const t = cell * between(0.55, 0.9);
      const ring = [
        [lng, lat], [lng + w, lat], [lng + w, lat + t], [lng, lat + t], [lng, lat],
      ];
      const area = Math.round(between(320, 1400));
      const type = pick(h.types);
      const mkt = Math.round(h.mkt * between(0.78, 1.28));
      const admin = Math.round(h.admin * between(0.85, 1.15));
      const hasOffering = rnd() < 0.34;
      const unitsOffered = Math.round(between(2000, 12000) / 100) * 100;
      plot += 1;

      features.push({
        type: "Feature",
        id: plot,
        properties: {
          id: `P-${plot}`,
          dls_village: h.village,
          dls_basin: h.basin,
          dls_plot: plot,
          neighbourhood_en: h.en,
          neighbourhood_ar: h.ar,
          type,
          area_m2: area,
          admin_value_fils_m2: admin,
          market_value_fils_m2: mkt,
          height_m: Math.round(between(h.h[0], h.h[1])),
          offering_id: hasOffering ? `OFF-${plot}` : "",
          spv_name: hasOffering ? `Qitaa ${h.en} ${plot} LLC` : "",
          unit_price_fils: hasOffering ? 10_000 : 0,      // 10 JD per unit
          units_offered: hasOffering ? unitsOffered : 0,
          units_sold: hasOffering ? Math.round(unitsOffered * between(0.05, 0.99)) : 0,
          target_net_yield_bps: hasOffering ? Math.round(between(480, 820)) : 0,
          closes_at: hasOffering
            ? new Date(Date.now() + between(5, 90) * 864e5).toISOString()
            : "",
        },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }
}

mkdirSync("apps/web/public/data", { recursive: true });
writeFileSync(
  "apps/web/public/data/amman-parcels.geojson",
  JSON.stringify({ type: "FeatureCollection", features }),
);
console.log(`wrote ${features.length} parcels, ${features.filter(f => f.properties.offering_id).length} with live offerings`);
