# Qitaa (قطعة) — Master Blueprint
### A 3D spatial real-estate marketplace and fractional co-investment platform for Jordan

*Advisory panel: CTO (cloud-native 3D GIS) · Real Estate & Financial Legal Strategist (Jordan) · CPO (proptech & marketplaces)*

**Prepared 4 August 2026.** Two pieces of Jordanian legislation moved *this quarter* and both point directly at this business. Read §2.0 first — the regulatory timing is the single most important fact in this document.

---

## 0. The one-paragraph version

A Jordanian earning 700 JD/month cannot buy property. The minimum viable ticket in Amman is roughly 60,000 JD plus ~6% transfer costs, and the cultural default — putting savings into land — is closed to them. Qitaa lets them deploy 300 JD into a specific, visible parcel through a single-asset Jordanian LLC that holds the title deed at the Department of Lands & Survey. The 3D map is not decoration: it is the mechanism that makes an abstract security feel like a piece of ground, and it is the acquisition channel. Buy/sell/rent listings and a hyperlocal neighbourhood feed generate the supply and the audience; co-investment monetises them.

---

# PART 1 — ARCHITECTURE & TECH STACK BLUEPRINT
*CTO*

## 1.1 First: what GeoLibre actually is, and how to use it

You found `opengeos/GeoLibre` and asked how to connect the wires. Here is the honest answer, because getting this wrong would cost you three months.

**GeoLibre is a desktop GIS application** — Tauri v2 + React + TypeScript + MapLibre GL JS + DuckDB-WASM, shipped as a native binary. It is a QGIS-alternative for analysts: layer panels, attribute tables, style editors, a processing toolbox, a plugin system, a FastAPI sidecar for heavy work. Its v0.4.0 feature list is "load local GeoJSON/GeoParquet/GeoPackage/Shapefile, reorder layers, edit fill and stroke."

**It is not a consumer web product and you should not fork it as one.** A person on a 4G phone in Zarqa does not want a layer panel. Forking GeoLibre and stripping it down would leave you maintaining a desktop app shell you don't need.

What you *should* take from it — three things, and they're the valuable ones:

| Take from GeoLibre | Why | Where it lands in Qitaa |
|---|---|---|
| **The stack choice itself** | MapLibre GL JS + PMTiles + DuckDB-WASM is exactly right, and GeoLibre is proof the combination works in production TypeScript | Your entire frontend map layer |
| **The plugin architecture** (`packages/plugins`, `GeoLibreAppAPI`) | A clean `activate(app)/deactivate()` contract over the map instance | Adopt the same pattern for Qitaa map "modes" — invest overlay, comparables heatmap, zoning inspector — so each is independently testable and lazily loaded |
| **The DuckDB-WASM spatial pattern** | Query GeoParquet in the browser, no API round trip | Comparable-sales analysis, price-per-m² histograms, "show me everything under 400 JD/m² within 2 km" — all client-side |
| **GeoLibre as an internal tool** | Your ops team must QA cadastral geometry before it goes live | Run GeoLibre *as-is*, unmodified, as the data-ops desktop app for your GIS analyst. Zero engineering cost, immediate value. |

MIT licensed, so all of this is clean. **Concrete recommendation: use GeoLibre unforked as your internal data-QA tool, and copy its architectural patterns into a purpose-built consumer app.**

## 1.2 Frontend architecture

**Stack:** Next.js 15 (App Router, React 19) · MapLibre GL JS v5 · PMTiles v4 · Tailwind · DuckDB-WASM for client-side analytics · Capacitor for the mobile shell in Phase 2.

Why Next.js and not a pure SPA: a marketplace lives or dies on organic search. Every listing needs a server-rendered, indexable URL (`/amman/abdoun/villa-P-1042`) with schema.org `RealEstateListing` markup. The map is one client component inside an otherwise SSR app.

**The four rendering layers, bottom to top:**

1. **Basemap** — OpenFreeMap Liberty style (free, no API key, OpenMapTiles schema). Self-host the style JSON so you control label language; Jordan needs Arabic-first labels with English fallback (`["coalesce", ["get","name:ar"], ["get","name:en"], ["get","name"]]`).
2. **Terrain** — `raster-dem` source, Terrarium encoding, from the Mapzen/AWS open elevation tiles. Amman is built across seven-plus jebels and wadis; flat 3D looks wrong to a local instantly. `exaggeration: 1.25`, plus a `hillshade` layer at low opacity.
3. **Context massing** — the basemap's own `building` source-layer as `fill-extrusion` using `render_height`. Free 3D city, no data work. Upgrade path: 3D Tiles / photogrammetry for Abdoun and Downtown only, where the sales value is highest.
4. **Cadastral prisms** — your parcels, as `fill-extrusion` with a data-driven colour ramp. This is the product. Three modes (implemented in the demo repo):
   - *invest* — colour by offering fill percentage
   - *market* — colour by asking price per m²
   - *value gap* — market price ÷ DLS administrative value. This is a genuinely novel view; nobody in Jordan can see it today and it is where mispricing lives.

**Performance rules that matter on a mid-range Android in Amman:**

- Below z13, serve nothing from the API. PMTiles only. The API returns HTTP 400 for a low-zoom bbox request — see `apps/api/src/server.ts`.
- Use `promoteId` on the GeoJSON source and `feature-state` for hover. Re-setting `data` on every hover is the classic MapLibre performance bug.
- `fill-extrusion` above ~8k features drops frames. Tile the parcels (tippecanoe → PMTiles) rather than serving GeoJSON once you exceed a neighbourhood.
- Guard WebGL: ~4% of the Jordanian device base will fail `map.getCanvas()`. Ship a 2D static-image fallback with a listing list.

## 1.3 Backend & spatial data pipeline

```
DLS shapefiles (EPSG:30791 JTM)          OSM Jordan extract (Geofabrik)
        │  ogr2ogr -t_srs EPSG:4326              │  ogr2ogr + filter
        ▼                                        ▼
   GeoParquet (ZSTD) ──── DuckDB spatial ──── GeoJSONSeq
        │                                        │
        │  COPY … FROM parquet                   │  tippecanoe z13-16
        ▼                                        ▼
   PostgreSQL 17 + PostGIS 3.5            *.mbtiles → pmtiles convert
   (transactional truth)                          │
        │                                         ▼
        │                            S3 / Cloudflare R2 + CDN
   Fastify API (bbox → GeoJSON)      (immutable, date-versioned, range reads)
        │                                         │
        └──────────────► Next.js / MapLibre ◄─────┘
                                 │
                          DuckDB-WASM reads the same
                          .parquet for client-side comps
```

The whole pipeline is scripted in `infra/tiles/build-tiles.sh`.

**Why PMTiles and not a tile server.** A single immutable archive on a CDN, read by HTTP range request. No tile server process, no per-tile compute cost, no cache-invalidation story. At Jordan's scale this is the difference between a ~$40/month and a ~$800/month infrastructure bill. Version archives by date and flip the client pointer atomically, so a bad tile build can never half-deploy.

**Why PostGIS is still the truth.** Tiles are a read-optimised projection. Ownership, money and the cap table live in Postgres, in one transaction, with foreign keys. Never let a tile archive be the system of record for anything a regulator will ask about.

**Realtime (community + offering counters):** Postgres `LISTEN/NOTIFY` → a small fan-out service → WebSocket. Redis for presence and rate limiting. Do not reach for Kafka; you will have hundreds of concurrent users, not millions. Push notifications via FCM/APNs — and note that in Jordan, WhatsApp is the real notification channel; budget for a WhatsApp Business API integration by Phase 2.

**Two Jordan-specific engineering constraints most teams miss:**

1. **Addressing.** Jordan has no reliable street-address system. The DLS primitive is `(village_no, basin_no, plot_no)` — قرية / حوض / قطعة. Model this as a first-class composite key with a unique constraint, and expose it in the UI in Arabic. Users will verify a listing by basin number, not by street.
2. **Ownership is denominated in *sahm*, not m².** A parcel is conventionally divided into **2,400 sahm** on the title deed. "You own 12 m²" is a display abstraction over an integer sahm fraction. `packages/domain/src/shares.ts` keeps the two reconcilable so every square-metre claim traces back to an exact integer position on the deed. Get this wrong and your first audit fails.

## 1.4 Database schema

Full DDL: `packages/db/migrations/0001_core.sql` (~360 lines, runs clean on PostGIS 17-3.5). Core design decisions:

**Money.** `BIGINT` fils. 1 JOD = 1,000 fils. No floats, no `NUMERIC` for currency, ever. Percentages are basis points (integers). `packages/domain/src/money.ts` enforces this at the type level and throws on sub-fils precision.

**Geometry.** Store `geometry(...,4326)`; a `GENERATED ALWAYS AS (ST_Transform(geom,3857)) STORED` column for tiling; cast to `geography` for true-metre distance. GiST index on every geometry column.

| Table | Purpose | The one thing that matters |
|---|---|---|
| `users` | Identity | `national_id_hash bytea` — SHA-256 with pepper. Never store a raw national number. `home_point` drives the hyperlocal feed radius. |
| `admin_areas` | Governorate → district → locality → **basin (حوض)** | Level 4 *is* the DLS basin. Your geography must mirror the registry's. |
| `parcels` | Cadastral truth | `total_sahm DEFAULT 2400`, unique on `(village, basin, plot)`. Generated centroid and 3857 columns. |
| `buildings` | 3D massing | Separate from `properties` — one parcel can carry many footprints |
| `properties` | The tradable asset | `unit_no`/`floor_no` for the floor-ownership regime; `jsonb attributes` + GIN index for the long tail |
| `listings` | Buy/sell/rent | `tsvector` on the `arabic` text-search config. Arabic search is a hard requirement, not a nice-to-have. |
| `spvs` | One LLC per deal | `CHECK (registered_capital_fils = total_units * unit_par_fils)`. Every investor unit maps 1:1 to an LLC quota unit, so **the cap table *is* the CCD shareholder register.** |
| `spv_title_holdings` | The SPV's position on the deed | `sahm_held` + `deed_no`. This is what reconciles software to the tapu. |
| `offerings` | The raise | `min_raise_fils` (below it, full refund), `max_ticket_pct` concentration cap, `max_investors` guard, and — critically — `prospectus_uri`, `valuation_uri`, `valuer_license_no`, `jsc_filing_ref` must be non-null before status can leave `draft` |
| `investment_orders` | Commitments | `cooling_off_ends` — build the statutory withdrawal window in from day one |
| `share_positions` | **Append-only** cap table | Never `UPDATE` a holding. Current position = `SUM(delta_units)`. The `v_cap_table` view materialises it. |
| `ledger_accounts` / `ledger_entries` | Double-entry | `assert_txn_balanced()` raises on any unbalanced transaction. Regulators ask for a ledger, not a balances table. |
| `distributions` / `distribution_lines` | Rental payouts | Per-period, per-investor, with a withholding column |
| `community_posts` | Hyperlocal feed | `visibility_radius_m` per post; `ST_DWithin` on geography |
| `audit_log` | Immutable trail | Non-negotiable evidence for JSC/CMA and CBJ AML review |

The four queries that carry the product — viewport fetch, hyperlocal feed, comparable-sales valuation, and nightly cap-table reconciliation — are written out with index notes in `packages/db/src/queries.sql`. The reconciliation query is an *alarm*: it returns rows only when units issued exceed units authorised.

---

# PART 2 — JORDANIAN LEGAL & FINANCIAL STRUCTURE
*Real Estate & Financial Legal Strategist*

> **Not legal advice.** This is an execution map to take to Jordanian counsel. Every statutory reference below must be verified against the gazetted text before you rely on it. You told me you are pre-formation — so this section is written as a sequence of things to *do*, in order.

## 2.0 Read this first: the regulatory window just opened

Two pieces of legislation moved in the last three months, and both are directly load-bearing for this business.

**(a) The Securities Law amendment — Cabinet approved 10 May 2026, now before the Lower House.** It does four things that matter to you:
- **It provides for the licensing of equity crowdfunding platforms** ("التمويل الجماعي بالمُلكية") — explicitly framed as pooling small savings into larger productive investments through a regulated mechanism. *This is the licence your business needs, and it does not exist yet.*
- It renames the Jordan Securities Commission the **Capital Market Authority**.
- It permits **mutual funds to invest in real estate** for the first time — a second, fund-based structural route.
- It regulates trading in **digital securities**, which is your eventual secondary-market path.

**(b) The amended Real Estate Ownership Law of 2026 — passed the Lower House on 4 August 2026 (37 articles).** It:
- **Replaces the unanimity requirement for partition (إفراز) with a 75% threshold**, provided remaining co-owners' rights are preserved. This materially de-risks the exit path from any co-ownership position.
- Formalises **electronic sales, electronic signature verification, and full digitisation** of payments, partition and sale transactions.
- Permits **off-plan sale and partition** before construction, backed by bank-approved allocation certificates.
- Grants the **DLS Director authority to issue instructions on payment methods** in real-estate transactions, including cash limits and approved electronic payment methods.

**Strategic read.** You are not asking Jordan to invent a category for you — the category is being written right now, and the digitisation provisions are an explicit invitation for a platform like this. The correct posture is not "launch and hope." It is: **build the marketplace and community now under existing rules, and be first in the queue when the equity-crowdfunding licensing regime issues its instructions.** Regulators reward the applicant who arrives with a working product, real users, and a compliance file already assembled.

## 2.1 The core legal problem, stated precisely

Jordanian law recognises undivided co-ownership — **الشيوع / Mulkiyyat Al-Shuyu'** — and the DLS will register multiple names against one parcel in *sahm*. So why not just register 200 investors directly on the deed?

Four reasons it fails:

1. **Transaction cost.** Every entry and every exit is a DLS transfer with a fee (broadly ~6% total on the administratively assessed value, split between parties, with concessions for first-time apartment buyers and small apartments — confirm current rates with DLS). A 300 JD ticket cannot absorb a percentage-based registration fee. Fractional ownership at retail scale is *arithmetically impossible* on-deed.
2. **Governance paralysis.** Any co-owner may seek removal of joint ownership (إزالة الشيوع). Two hundred co-owners means two hundred people who can force a judicial sale. The 2026 law's 75% partition threshold helps, but it does not fix the underlying fragility.
3. **Liquidity.** An undivided share is transferable in principle and unsellable in practice. There is no market for 1/2,400 of a plot in Jabal Amman.
4. **Practical registry limits.** Whatever the theoretical ceiling, no DLS office is registering 200 names against one plot for a 300 JD ticket.

**The resolution: separate the legal title from the economic interest.** One legal owner on the deed — a company. Many economic owners of that company. This is the standard global structure and it is available in Jordan.

## 2.2 The SPV structure

```
  Investor (300 JD)                            DLS Title Deed (سند التسجيل)
        │                                       Owner: "Qitaa Abdoun 1042 LLC"
        │ owns quota units                      2,400 / 2,400 sahm
        ▼                                                ▲
┌───────────────────────┐                                │ registered owner
│  Qitaa Abdoun 1042    │ ───────────────────────────────┘
│  LLC (ذ.م.م)          │
│  Registered: CCD, MoIT│
│  Capital: 250,000 JD  │
│  = 25,000 units ×10 JD│
└───────────────────────┘
        ▲ manages (no ownership)
        │
┌───────────────────────┐
│ Qitaa Technologies LLC│  ← the platform. Never holds investor funds or title.
│  (the operating co.)  │     Revenue = management fee + listing/transaction fees.
└───────────────────────┘
```

**Why one SPV per asset, not one fund.** Bankruptcy remoteness: a problem in the Khalda building cannot reach the Abdoun villa. It also makes each raise a discrete, separately-disclosable offering, which is far easier to get past a regulator than a blind pool. The cost is real — one company registration, one set of accounts, one audit per deal — and it is the single biggest line item in your unit economics. Model it explicitly (§3.5).

## 2.3 Step-by-step execution path

**Phase A — Platform entity (weeks 1–4)**
1. Register **Qitaa Technologies LLC** with the **Companies Control Department (CCD)** at the Ministry of Industry, Trade & Supply. LLC minimum capital is modest — typically from ~1,000 JD; under the 2024 amendment 50% of capital is paid at incorporation and the balance within 60 days. The old 50,000 JD foreign-investor minimum was abolished and now only sets the Investor Card threshold.
2. Objects clause: draft it as **technology and information services** — software platform, digital marketing, data services. Do **not** write "real estate brokerage" or anything that reads as financial intermediation unless and until you hold the corresponding licence. The objects clause is the first thing a regulator reads.
3. Note foreign-ownership caps if you plan on non-Jordanian shareholders: up to 100% is permitted in most sectors, but certain trading and service activities are capped at 50%. Confirm your specific ISIC codes.
4. Tax registration, social security registration, corporate bank account.

**Phase B — Marketplace and community launch (months 2–8). No securities activity.**
5. Operate listings, search, the 3D map, and the neighbourhood feed. Revenue: listing fees, featured placement, agency subscriptions. This phase is **outside** securities regulation entirely. It builds the audience and — more importantly — the transaction dataset that makes your later valuations defensible.
6. Publish a neighbourhood price index from your own listing data. This is a moat and a PR asset and costs you nothing extra.

**Phase C — Regulatory groundwork, in parallel from month 3**
7. **Engage the JSC / incoming Capital Market Authority early and in writing.** Request a formal no-objection or guidance letter describing your intended structure. In a market this size, being a known, cooperative applicant is worth more than any legal opinion.
8. **Engage the Central Bank of Jordan** on the money-movement leg. You will not hold client funds directly — you will use a **CBJ-licensed payment service provider** and a **segregated escrow account** at a Jordanian bank. Note that the CBJ's December 2024 amendments to the Finance Companies Bylaw formalised a **regulatory sandbox** and introduced **tiered licensing for crowdfunding providers**; lending-based crowdfunding sits under the Finance Companies Law, equity-based under securities regulation. Apply to the sandbox — it is designed for exactly this.
9. Appoint a **compliance officer** and an **MLRO**. Write the AML/CFT policy, the KYC procedure, the suitability-assessment procedure, and the complaints procedure *before* you need them.
10. Retain a **DLS-licensed valuer** on a framework agreement. Every offering needs an independent valuation with a named, licensed valuer. This is your single most attackable point in an investor dispute.

**Phase D — First SPV (months 8–14)**
11. Identify the asset. Sign a conditional purchase agreement with a financing condition and a long stop date.
12. Register **[Asset] SPV LLC** at the CCD. Capital = purchase price + transfer fees + reserve. Split into whole quota units at a par value that makes your target minimum ticket a clean integer (10 JD/unit → 300 JD = 30 units).
13. Draft the **memorandum and articles** with the four provisions that make this work as an investment product:
    - **Manager appointment** — Qitaa Technologies as manager, with defined powers and a defined fee.
    - **Distribution waterfall** — the exact sequence in §3.4 below, written into the articles, not into a side letter.
    - **Drag-along and tag-along** on a qualified sale of the underlying asset. Without drag-along you cannot exit.
    - **Transfer mechanics** — pre-emption rights and a manager-facilitated internal transfer process. This is the legal foundation of your eventual secondary market.
14. Open the **segregated SPV bank account**. Investor money never touches Qitaa Technologies' account. Not once. This is the difference between a regulated business and a fraud prosecution.
15. Run the raise. Escrow all subscriptions. If the minimum raise fails, refund in full — the code path is already written and tested (`allocateProRata` + the `failed` branch in `POST /offerings/:id/close`).
16. On close: complete the DLS transfer into the SPV's name, file the shareholder register at the CCD, and reconcile the cap table to both. The nightly reconciliation query in `queries.sql` alarms on drift.

## 2.4 Regulatory risk matrix

| # | Risk | Regulator | Likelihood | Severity | Mitigation |
|---|---|---|---|---|---|
| R1 | Offering units is an unlicensed public offer of securities | JSC / CMA | **High** | **Critical** — criminal exposure, platform shutdown | Do not launch co-investment before either (a) the equity-crowdfunding licence exists and you hold it, or (b) you have written JSC guidance for a private-placement structure. Cap investor count per SPV, restrict to a pre-registered, KYC'd, suitability-assessed member base, and no public solicitation of a specific deal. |
| R2 | Structure is recharacterised as a collective investment scheme | JSC / CMA | Medium | High | One SPV per identified asset, disclosed before subscription. Never a blind pool. Never pool across assets. |
| R3 | Holding client money without a licence | CBJ | **High** | **Critical** | Segregated escrow at a licensed bank + a CBJ-licensed PSP for collection. Platform is never a counterparty to the money. Apply to the CBJ sandbox. |
| R4 | AML/CFT failure — unverified investors, source of funds | CBJ / AMLU | Medium | High | Mandatory KYC before any subscription. National ID verification, PEP and sanctions screening, source-of-funds declaration above a threshold, transaction monitoring, MLRO with a reporting line to the board. |
| R5 | DLS refuses or delays registering the SPV as owner | DLS | Low | High | Pre-clear the structure with the relevant DLS directorate before signing. Use a Jordanian-owned LLC to avoid any foreign-ownership approval path on the first deals. |
| R6 | Transfer-fee treatment on a later sale of *units* rather than the asset | ISTD / DLS | **Medium** | **High** | Get a written tax ruling on whether transferring LLC quota units is treated as an indirect property transfer. **This determines whether a secondary market is viable at all.** Do this in month 3, not month 30. |
| R7 | Investor dispute over valuation | Courts | Medium | Medium | Independent DLS-licensed valuer, valuation report published with the offering, and a documented conflicts policy. |
| R8 | Riba / Shari'a objection deterring a large slice of the market | Market, not regulator | **High** | Medium | The structure is already equity, not debt — asset-backed, profit-and-loss sharing, no interest. **Obtain a fatwa from a recognised Shari'a board and publish it.** In Jordan this is a growth lever, not a compliance cost. |
| R9 | Data protection — you are processing national IDs and location | Personal Data Protection Law | Medium | Medium | Hash national IDs, minimise retention, appoint a DPO, publish an Arabic privacy notice. |
| R10 | Platform insolvency stranding investors | — | Low | **Critical** | SPVs are legally independent of the platform. Document a manager-replacement mechanism in the articles so investors can appoint a successor manager if Qitaa fails. Say this out loud in your marketing; it is a trust asset. |

## 2.5 The structuring question to put to counsel first

One question determines your entire roadmap:

> *Under the Securities Law as amended, and pending the equity-crowdfunding instructions, can Qitaa offer quota units in a single-asset LLC to a closed, pre-registered, KYC-verified membership of no more than N Jordanian residents, with a per-person cap of X JD, without that constituting a public offering requiring a prospectus and a licensed intermediary?*

If the answer is yes with a workable N and X, you can run a **members-only private syndication** and start generating real track record while the licensing regime is finalised. If the answer is no, you wait for the licence and monetise the marketplace in the meantime. Either way, you keep building — but you need the answer before you write a line of the co-investment payment flow.

---

# PART 3 — MVP ROADMAP & FEATURE TRIAGE
*CPO*

## 3.1 The sequencing principle

Everyone building this business makes the same mistake: they build the investment product first, because it is the exciting part, and then discover they have no users and no assets. **The marketplace is not a stepping stone to the co-investment product. It is the supply engine, the audience, and the data moat that make the co-investment product possible.**

Concretely: your first SPV needs an asset priced correctly, and the only way to price it defensibly is to already have six months of listing data for that neighbourhood. The marketplace generates the comparables that justify the valuation that satisfies the regulator.

## 3.2 Phase 1 — Launch (months 0–8). Goal: become the way Jordanians look at property.

**Build:**
- 3D map explorer — Amman first, then Irbid, Zarqa, Aqaba. Terrain, extruded buildings, parcel prisms, the three colour modes.
- Listings: create, search, filter, contact. Arabic-first UI, RTL throughout, Arabic full-text search.
- Agent/agency accounts with a verified badge and a listing quota.
- Neighbourhood pages: SSR, indexable, with a price index computed from your own data.
- Hyperlocal community feed, radius-scoped by home location. Topics: price check, services, disputes, general.
- WhatsApp-first notifications and lead handoff. This is not optional in Jordan.

**Explicitly do NOT build:** any co-investment feature, any wallet, any payment rail beyond a listing-fee card charge, a mobile app (mobile web first), or any city outside the four above.

**Monetisation:** agency subscriptions, featured listings, developer promotions. Modest, but it proves willingness to pay and funds the compliance work.

**Why the community pillar earns its place.** Property in Jordan is transacted through personal networks; trust is the binding constraint. A neighbourhood feed where a real person says "that building has a water problem" does three things: it produces retention that listings alone never will, it generates ground-truth data no competitor can scrape, and it manufactures the trust you will need when you later ask someone for 300 JD. Moderate it seriously from day one — an unmoderated Arabic property forum degrades within weeks.

## 3.3 Phase 2 — Monetisation (months 8–20). Goal: prove the co-investment unit economics on 3–5 assets.

**Gate: do not start until (a) legal clarity from §2.5, and (b) 25,000+ MAU with real listing supply.**

**Build:**
- KYC/AML onboarding — national ID verification, PEP/sanctions screening, source-of-funds, suitability questionnaire.
- Offering pages: prospectus, independent valuation, photos, 3D parcel view, full fee disclosure.
- Escrow subscription flow via a CBJ-licensed PSP (eFAWATEERcom / CliQ / mPSP wallets — Zain Cash, Orange Money, UWallet et al. all sit on the CBJ's JoMoPay switch).
- Pro-rata allocation and refund engine — **already built and tested** in `packages/domain/src/shares.ts`.
- Investor dashboard: units held, equivalent m² traced to the deed, distribution history, documents.
- Automated quarterly distribution waterfall — **already built and tested** in `packages/domain/src/waterfall.ts`.
- Double-entry ledger with balanced-transaction enforcement.
- Seller-side transaction fee on marketplace sales (this is where marketplace revenue actually scales).

**Phase 3 (months 20+):** internal secondary market for units — gated entirely on the R6 tax ruling and the digital-securities provisions of the amended Securities Law. Then rental-yield SPVs at scale, then geographic expansion.

## 3.4 The distribution waterfall (built, tested, in `packages/domain`)

```
gross rent collected
  − operating expenses (service charge, maintenance, insurance)
  − municipality / property tax accrual
  ─────────────────────────────────────────
  = net operating income (NOI)
  − CAPEX reserve            5% of NOI, capped at a target balance
  ─────────────────────────────────────────
  − platform management fee  10% of post-reserve NOI
  ─────────────────────────────────────────
  = distributable cash → pro rata by units held
```

Two implementation details that will save you an audit finding:
- The integer-division remainder ("dust") is **swept into the reserve**, never dropped. The ledger balances to the fil.
- A loss-making period distributes **zero**, it does not distribute a negative. NOI floors at zero and the loss carries in the ledger.

The management fee is charged on income, not on assets. Charging on AUM before you have a track record is how proptech platforms lose their first cohort.

## 3.5 Unit economics — the model you must not fool yourself about

Illustrative single SPV: **250,000 JD asset, 6.5% gross yield, 4.5% net to investors.**

| Line | Amount | Note |
|---|---|---|
| Asset price | 250,000 JD | |
| DLS transfer fees & registration | ~15,000 JD | ~6% — **confirm current rates with DLS**; concessions exist for apartments |
| SPV formation, legal, valuation, audit (year 1) | ~4,000 JD | The number that kills small deals |
| **Total raise required** | **~269,000 JD** | |
| Investors at a 300 JD average ticket | ~900 | The distribution problem, stated plainly |
| Platform acquisition fee (2% of asset) | 5,000 JD | One-off, at close |
| Annual management fee (10% of post-reserve NOI) | ~1,400 JD | Recurring |
| Annual SPV running cost (audit, filings, accounting) | ~2,500 JD | **Recurring, and larger than the management fee** |

**Look hard at the last two rows.** On a 250,000 JD asset, the recurring SPV cost exceeds the recurring management fee. The business does not work at this deal size on management fees alone. Three consequences, and you should design for all three now:

1. **Deal size must rise.** Target 600,000 JD–1.5m JD assets. SPV running costs are near-fixed, so margin is roughly linear in asset value.
2. **The acquisition fee is the real Phase-2 revenue.** Be transparent about it — disclose it in the offering — but understand it is what pays your salaries.
3. **Marketplace revenue must carry the platform.** Listings and transaction fees are the durable business; co-investment is the differentiator and the growth story. Anyone who tells you a fractional platform monetises on management fees at this asset size has not built the model.

## 3.6 KPIs to have in hand before a seed raise

**Marketplace health** — the ones investors actually diligence
| Metric | 12-month target | Why |
|---|---|---|
| Monthly active users | 25,000+ | Below this the co-investment funnel has no top |
| Active listings | 8,000+ | Supply density is what makes search useful |
| Listing supply growth, MoM | >15% | Proves the flywheel, not a one-off agency import |
| Contact rate (listing view → contact) | >4% | The single best proxy for listing quality |
| 30-day user retention | >25% | Below this you have a directory, not a product |
| Organic traffic share | >45% | SEO on neighbourhood pages is your cheapest channel |

**Community**
| Metric | Target | Why |
|---|---|---|
| Posts per active neighbourhood per week | >10 | Below this the feed reads dead and users stop opening it |
| % of MAU who read the feed | >30% | Proves it is a pillar, not a bolt-on |
| Median moderation response time | <2 hours | The variable that determines whether it survives |

**Co-investment (once live)**
| Metric | Target | Why |
|---|---|---|
| KYC completion rate | >60% | If this is below 40%, your onboarding is the whole problem |
| Time from offering open → fully funded | <21 days | Demand proof. Longer than 45 days and the model is broken. |
| Average ticket | 400–800 JD | Above 300 means you are reaching real savers, not just curiosity |
| Repeat investment rate (2nd offering) | >35% | **The single most important number in the business.** It separates a novelty from a savings product. |
| Distributions paid on time | 100% | One late distribution and the trust is gone |
| Cost of acquiring an investor / average ticket | <15% | Otherwise you buy revenue at a loss |

**The one slide a seed investor will actually stop on:** repeat investment rate, plotted against cohort. Everything else is table stakes.

---

# PART 4 — INVESTOR PITCH DECK (10 SLIDES)

Guidance for the whole deck: no stock photography, no "Uber for X". Every number cited on screen must be traceable to a source in your appendix. In this market, at this stage, credibility beats polish.

**1 — Title & one-line thesis**
> *Qitaa (قطعة) — Own a piece of Jordan, from 300 JD.*
> The 3D map of Jordanian property, and the first regulated way for ordinary Jordanians to invest in it.
Live product screenshot: Amman in 3D, one parcel lit, the invest panel open. Not a logo on white.

**2 — The problem, in one number**
Median Amman household income vs. minimum property ticket (~60,000 JD + ~6% transfer costs). Land is the default Jordanian savings instrument and it is closed to most Jordanians. Meanwhile deposit rates do not beat inflation and the ASE is not a retail product. **Say the number, then stop talking.**

**3 — Why now — the regulatory window**
The strongest slide in the deck, and most founders don't have one.
- Securities Law amendment (Cabinet, 10 May 2026): **licensing of equity crowdfunding platforms**, JSC → Capital Market Authority, mutual funds permitted into real estate, digital securities regulated.
- Amended Real Estate Ownership Law (Lower House, 4 Aug 2026): **75% partition threshold** replaces unanimity, **e-sales and e-signature formalised**, off-plan sale and partition permitted, DLS empowered to mandate electronic payment methods.
- CBJ (Dec 2024): regulatory sandbox formalised, tiered licensing for crowdfunding providers.
> *The category is being written into Jordanian law right now. We intend to be the first licensed applicant with a live product and a real user base.*

**4 — Product: the 3D map is the wedge**
Live demo, not screenshots. Show the *value gap* mode — market price ÷ DLS administrative value — and let it land that nobody in Jordan can see this today. Then the click-through: parcel → offering → 300 JD → "you own 0.72 m² of this plot." **The spatial layer is not a feature. It is what converts an abstract security into something a person can point at.**

**5 — How it works legally**
The diagram from §2.2, unadorned. Investor → LLC quota units → SPV → DLS title deed. Three sentences: one legal owner on the deed, many economic owners of that owner, platform never holds title or client money. Then the one line every serious investor is waiting for: *"Investor funds sit in a segregated escrow account at a licensed Jordanian bank. We never touch them."*

**6 — Market size**
Build TAM bottom-up and show your arithmetic; top-down numbers get discounted to zero.
- Jordan: population, urban households, banked adults, estimated household savings pool, realistic addressable share at a 300–2,000 JD ticket.
- Then annual Jordanian real-estate transaction volume × a defensible take rate = the marketplace TAM.
- Then the MENA expansion frame: Egypt, Morocco, Iraq — same undivided-ownership problem, same registry structure, same cultural preference for land, and no incumbent.
State the sources on the slide.

**7 — Business model & unit economics**
Three revenue lines, honestly weighted: marketplace (listings + transaction fees — the durable base), acquisition fee (2% at SPV close — the Phase-2 engine), management fee (10% of post-reserve NOI — the long-term annuity). Show the §3.5 table **including the row where SPV running cost exceeds management fee at small deal sizes**, and then show why 600k–1.5m JD deals fix it. Volunteering the weakness before they find it is worth more than hiding it.

**8 — Traction**
Marketplace metrics from §3.6 with real numbers and trend lines. Listing supply growth MoM, contact rate, 30-day retention, organic share. If co-investment is live: repeat investment rate by cohort. If it is not live yet, show the KYC-verified waitlist and the signed LOIs from asset owners. **No vanity metrics. A seed investor in this market has seen every inflated MAU chart there is.**

**9 — Moat**
Four layers, in increasing order of durability:
1. *Regulatory* — first licensed platform; the licence itself is the barrier, and you will have spent 18 months on it.
2. *Data* — cadastral geometry reconciled to DLS, plus your own transaction and comparables dataset. Cannot be scraped.
3. *Community* — neighbourhood feeds have local network effects; the second entrant into Khalda faces an empty room.
4. *Trust* — a public record of distributions paid on time, and a published Shari'a opinion.
Say plainly what is *not* a moat: the map technology. MapLibre and PMTiles are open source. The moat is the data in the map and the licence behind it.

**10 — The ask**
Amount, 18–24 month runway, and a use-of-funds split with named milestones — engineering, regulatory and licensing (call this out as a discrete line; it signals you understand the business), first SPV working capital, and market entry. Close on the three specific milestones the round buys: licence application filed, first three SPVs funded and distributing, marketplace at N MAU.

---

## Appendix A — Sources for the legal and regulatory claims

- [Cabinet Approves Amendments to Securities Law, Expands Investment, Governance Framework — Petra, 10 May 2026](https://petra.gov.jo/en/news/cabinet-approves-amendments-to-securities-law-expands-investment-governance-framework)
- [Lower House Endorses Amended Real Estate Ownership Law — Petra, 4 Aug 2026](https://petra.gov.jo/en/news/lower-house-endorses-amended-real-estate-ownership-law)
- [Government unveils key amendments of 2026 Amended Real Estate Ownership Bill — Ammon News, 14 Jul 2026](https://en.ammonnews.net/article/93303)
- [DLS: Draft Real Estate Ownership Bill Imposes No New Taxes or Fees — Petra](https://petra.gov.jo/en/news/dls-draft-real-estate-ownership-bill-imposes-no-new-taxes-or-fees)
- [Jordan Securities Commission — Regulations](https://www.jsc.gov.jo/Links2/en/Regulations) · [JSC Licensing](https://www.jsc.gov.jo/licensing.aspx?lang=en)
- [Company Formation in Jordan: Foreign Ownership & the CCD (2026)](https://haqq.ai/blog/tasees-sharika-jordan)
- [Foreign Investment Law Jordan 2026: Incentives, Registration Steps & Repatriation](https://globaladvisoryexperts.com/foreign-investment-law-jordan-2026-incentives-registration-steps-repatriation/)
- [Jordan Investment Regulation Changes (2026) — Global Law Experts](https://globallawexperts.com/jordan-investment-regulation-changes-2026/)
- [Mobile Payment Service (JoMoPay) — Central Bank of Jordan](https://www.cbj.gov.jo/EN/Pages/Mobile_Payment_Service_JoMoPay)
- [Property Ownership Transfer Fees — Homes Jordan](https://www.homes-jordan.com/en/blogs/detail/property-ownership-transfer-fees) · [Cost of Buying Property in Jordan (2026)](https://tajalsafa.com/cost-of-buying-property-in-jordan-2026)
- [Land, Housing and Property in Jordan — UN-Habitat](https://unhabitat.org/sites/default/files/2024/05/land_housing_and_property_in_jordan_report.pdf)
- [opengeos/GeoLibre](https://github.com/opengeos/GeoLibre) — MIT licensed

Transfer-fee percentages and capital thresholds vary by property type, buyer status and periodic government concessions, and reporting on them is inconsistent. **Confirm every figure with the DLS and the CCD directly before it enters a financial model or an offering document.**
