# Qitaa (قطعة)

**3D spatial real-estate marketplace and fractional co-investment platform for Jordan.**
Own a piece of Jordan, from 300 JD.

> Read [`MASTER_BLUEPRINT.md`](./MASTER_BLUEPRINT.md) first. It contains the architecture rationale, the Jordanian legal execution path (SPV structure, DLS, JSC/CMA, CBJ), the roadmap and KPIs, and the investor deck outline. This README covers only how to run the code.

---

## What's here

```
apps/
  web/          Next.js 15 + React 19 + MapLibre GL JS v5 — the 3D explorer
  api/          Fastify + PostGIS — viewport queries, offering close, distributions
packages/
  domain/       Pure TypeScript: fils money, sahm↔m² reconciliation,
                pro-rata allocation, distribution waterfall. 13 unit tests.
  db/           PostGIS DDL (0001_core.sql) + the four load-bearing queries
infra/
  postgres/     Extension bootstrap
  tiles/        DLS/OSM → GeoParquet → tippecanoe → PMTiles pipeline
scripts/
  gen-parcels.mjs   Deterministic 370-parcel Amman fixture for the demo
```

## Quick start (demo mode — no database required)

```bash
npm install
node scripts/gen-parcels.mjs      # writes apps/web/public/data/amman-parcels.geojson
npm run dev                        # http://localhost:3000
```

You get Amman in 3D with terrain, extruded buildings, 370 cadastral prisms across six real
neighbourhoods, three colour modes (offering fill / asking price per m² / value gap vs. the DLS
administrative value), and a working investment calculator that runs the real distribution
waterfall from `@qitaa/domain`.

## Full stack

```bash
cp .env.example .env
docker compose up -d              # PostGIS 17-3.5, MinIO, Redis
npm run db:migrate                 # applies packages/db/migrations/0001_core.sql
npm run dev:api                    # http://localhost:4000
npm run dev                        # http://localhost:3000
```

## Tests

```bash
npx vitest run                     # 13 tests — money, allocation, sahm, waterfall
npm run typecheck --workspaces     # strict mode, noUncheckedIndexedAccess, exactOptionalPropertyTypes
```

## Design rules that are not negotiable

1. **Money is `bigint` fils.** 1 JOD = 1000 fils. No floats touch a monetary value, anywhere.
   `jod()` throws on sub-fils precision. Percentages are basis points.
2. **The cap table is append-only.** Never `UPDATE` a holding — insert a `delta_units` row.
   Current position is `SUM(delta_units)`. See `v_cap_table`.
3. **Ownership reconciles to *sahm*, not m².** A DLS parcel is 2,400 sahm on the deed. Every
   "you own 12 m²" claim traces to an exact integer sahm position (`packages/domain/src/shares.ts`).
4. **Every ledger transaction balances.** `assert_txn_balanced()` raises otherwise.
5. **Store 4326, index 3857, measure in `geography`.** GiST on every geometry column.
6. **Below zoom 13 the API returns 400.** Low-zoom reads come from PMTiles, never the database.

## On GeoLibre

[`opengeos/GeoLibre`](https://github.com/opengeos/GeoLibre) (MIT) is a **desktop** GIS built on
Tauri — not a consumer web app, and not something to fork for this. What this project takes from
it: the stack thesis (MapLibre + PMTiles + DuckDB-WASM), the plugin `activate/deactivate` contract
applied to map modes, and the client-side GeoParquet analytics pattern. Run GeoLibre unmodified as
your internal cadastral data-QA tool. Full reasoning in §1.1 of the blueprint.

## Status

Domain logic is tested and correct. The web app typechecks clean under strict TypeScript and is
wired end to end. The API and schema are complete but have not been run against a live PostGIS
instance — do that first when you pick this up.

**No co-investment feature in this repository should be operated with real money before the legal
steps in §2.3 of the blueprint are complete.**
