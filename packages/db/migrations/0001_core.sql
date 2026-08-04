-- =====================================================================
-- Qitaa core schema — PostgreSQL 17 + PostGIS 3.5
-- SRID policy: store geodetic in 4326, index a generated 3857 column for
-- tiling, and use geography(...) casts for true metric ops.
-- Jordan national grid is JTM (EPSG:30791/28191); ingest reprojects to 4326.
-- Money policy: NEVER float. JOD is stored as BIGINT fils (1 JOD = 1000 fils).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------- enums
CREATE TYPE user_kyc_status  AS ENUM ('none','pending','verified','rejected','expired');
CREATE TYPE listing_kind     AS ENUM ('sale','rent','coinvest');
CREATE TYPE property_type    AS ENUM ('land','villa','apartment','office','retail','building','farm');
CREATE TYPE tenure_type      AS ENUM ('mulk','miri','waqf','treasury');       -- ملك / ميري / وقف
CREATE TYPE listing_status   AS ENUM ('draft','pending_review','active','reserved','closed','rejected');
CREATE TYPE spv_status       AS ENUM ('forming','registered','title_held','distributing','winding_down','dissolved');
CREATE TYPE offering_status  AS ENUM ('draft','regulatory_review','open','funded','failed','settled','exited');
CREATE TYPE order_status     AS ENUM ('pending','escrowed','allocated','refunded','cancelled');
CREATE TYPE ledger_direction AS ENUM ('debit','credit');

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164         text UNIQUE NOT NULL,                  -- +9627XXXXXXXX, primary identity in JO
  email              citext UNIQUE,
  full_name_ar       text,
  full_name_en       text,
  national_id_hash   bytea,        -- SHA-256(national number + pepper). Never store raw.
  nationality        char(2) NOT NULL DEFAULT 'JO',
  kyc_status         user_kyc_status NOT NULL DEFAULT 'none',
  kyc_verified_at    timestamptz,
  kyc_provider_ref   text,
  is_accredited      boolean NOT NULL DEFAULT false,        -- JSC/CMA professional-investor test
  risk_score         smallint NOT NULL DEFAULT 0,           -- AML risk band 0-100
  pep_flag           boolean NOT NULL DEFAULT false,
  home_point         geometry(Point,4326),                  -- for hyperlocal feed radius
  locale             text NOT NULL DEFAULT 'ar-JO',
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX users_home_gix ON users USING GIST (home_point);
CREATE INDEX users_kyc_idx  ON users (kyc_status) WHERE deleted_at IS NULL;

-- ------------------------------------------------------- administrative
-- Governorate → District (لواء) → Locality/Basin (حوض). Basin+parcel is the
-- DLS addressing primitive: (village_no, basin_no, plot_no).
CREATE TABLE admin_areas (
  id          bigserial PRIMARY KEY,
  parent_id   bigint REFERENCES admin_areas(id),
  level       smallint NOT NULL,          -- 1 governorate, 2 district, 3 locality, 4 basin(حوض)
  code        text NOT NULL,
  name_ar     text NOT NULL,
  name_en     text,
  geom        geometry(MultiPolygon,4326) NOT NULL,
  UNIQUE (level, code)
);
CREATE INDEX admin_areas_gix ON admin_areas USING GIST (geom);

-- ------------------------------------------------------------- parcels
-- Cadastral truth. One row per DLS-registered plot (قطعة).
CREATE TABLE parcels (
  id                bigserial PRIMARY KEY,
  dls_village_no    integer NOT NULL,     -- رقم القرية
  dls_basin_no      integer NOT NULL,     -- رقم الحوض
  dls_plot_no       integer NOT NULL,     -- رقم القطعة
  admin_area_id     bigint REFERENCES admin_areas(id),
  tenure            tenure_type NOT NULL DEFAULT 'mulk',
  -- DLS registers ownership in 2400 sahm (shares) per parcel, not in m².
  total_sahm        integer NOT NULL DEFAULT 2400 CHECK (total_sahm > 0),
  registered_area_m2 numeric(14,2) NOT NULL CHECK (registered_area_m2 > 0),
  zoning_code       text,                 -- e.g. 'A','B','C','D' residential / commercial
  far               numeric(5,2),         -- floor-area ratio from GAM zoning
  max_height_m      numeric(6,2),
  geom              geometry(Polygon,4326) NOT NULL,
  geom_3857         geometry(Polygon,3857)
                    GENERATED ALWAYS AS (ST_Transform(geom,3857)) STORED,
  centroid          geometry(Point,4326)
                    GENERATED ALWAYS AS (ST_PointOnSurface(geom)) STORED,
  source            text NOT NULL DEFAULT 'dls',
  source_updated_at timestamptz,
  UNIQUE (dls_village_no, dls_basin_no, dls_plot_no)
);
CREATE INDEX parcels_gix       ON parcels USING GIST (geom);
CREATE INDEX parcels_gix_3857  ON parcels USING GIST (geom_3857);
CREATE INDEX parcels_centroid_gix ON parcels USING GIST (centroid);
CREATE INDEX parcels_admin_idx ON parcels (admin_area_id);

-- 3D massing: one row per building footprint, extruded client-side.
CREATE TABLE buildings (
  id            bigserial PRIMARY KEY,
  parcel_id     bigint REFERENCES parcels(id) ON DELETE SET NULL,
  height_m      numeric(6,2),
  min_height_m  numeric(6,2) NOT NULL DEFAULT 0,
  floors        smallint,
  year_built    smallint,
  geom          geometry(Polygon,4326) NOT NULL,
  source        text NOT NULL DEFAULT 'osm'   -- osm | photogrammetry | dls
);
CREATE INDEX buildings_gix ON buildings USING GIST (geom);

-- --------------------------------------------------------------- assets
-- A tradable real-world asset. Always anchored to a parcel; an apartment
-- additionally carries a floor/unit under the Jordanian floor-ownership regime.
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id       bigint NOT NULL REFERENCES parcels(id),
  building_id     bigint REFERENCES buildings(id),
  type            property_type NOT NULL,
  title_ar        text NOT NULL,
  title_en        text,
  description_ar  text,
  unit_no         text,             -- شقة/طابق for floor-ownership units
  floor_no        smallint,
  area_m2         numeric(12,2) NOT NULL CHECK (area_m2 > 0),
  bedrooms        smallint,
  bathrooms       smallint,
  built_year      smallint,
  -- denormalised point for fast map queries; kept in sync by trigger
  geom            geometry(Point,4326) NOT NULL,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX properties_gix       ON properties USING GIST (geom);
CREATE INDEX properties_attrs_gin ON properties USING GIN (attributes jsonb_path_ops);
CREATE INDEX properties_type_idx  ON properties (type);

CREATE OR REPLACE FUNCTION properties_sync_geom() RETURNS trigger AS $$
BEGIN
  IF NEW.geom IS NULL THEN
    SELECT centroid INTO NEW.geom FROM parcels WHERE id = NEW.parcel_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER properties_geom_bi BEFORE INSERT OR UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_sync_geom();

-- ------------------------------------------------------------- listings
CREATE TABLE listings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES users(id),
  kind           listing_kind NOT NULL,
  status         listing_status NOT NULL DEFAULT 'draft',
  price_fils     bigint CHECK (price_fils IS NULL OR price_fils > 0),   -- sale price
  rent_fils_mo   bigint CHECK (rent_fils_mo IS NULL OR rent_fils_mo > 0),
  currency       char(3) NOT NULL DEFAULT 'JOD',
  published_at   timestamptz,
  expires_at     timestamptz,
  search_ar      tsvector GENERATED ALWAYS AS (to_tsvector('arabic', coalesce(title_cache,''))) STORED,
  title_cache    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ( (kind='sale'  AND price_fils   IS NOT NULL)
       OR (kind='rent'  AND rent_fils_mo IS NOT NULL)
       OR (kind='coinvest') )
);
CREATE INDEX listings_status_idx ON listings (status, kind) WHERE status='active';
CREATE INDEX listings_search_gin ON listings USING GIN (search_ar);

-- ============================================================== SPV LAYER
-- Each co-investment deal = one Jordanian LLC (شركة ذات مسؤولية محدودة)
-- registered at the Companies Control Department, holding the DLS title.
CREATE TABLE spvs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar              text NOT NULL,
  name_en              text NOT NULL,
  ccd_registration_no  text UNIQUE,          -- Companies Control Dept. number
  national_tax_no      text,
  status               spv_status NOT NULL DEFAULT 'forming',
  incorporated_on      date,
  registered_capital_fils bigint NOT NULL CHECK (registered_capital_fils > 0),
  -- CCD requires capital split into whole shares (حصص). Every investor unit
  -- maps 1:1 to an LLC quota unit so the cap table IS the shareholder register.
  total_units          bigint NOT NULL CHECK (total_units > 0),
  unit_par_fils        bigint NOT NULL CHECK (unit_par_fils > 0),
  manager_user_id      uuid REFERENCES users(id),
  bank_iban            text,                 -- segregated SPV account
  articles_uri         text,                 -- signed memorandum & articles (S3)
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (registered_capital_fils = total_units * unit_par_fils)
);

-- The SPV's registered interest in a parcel, expressed in DLS sahm so the
-- on-chain-of-title position always reconciles to the tapu (سند التسجيل).
CREATE TABLE spv_title_holdings (
  id             bigserial PRIMARY KEY,
  spv_id         uuid NOT NULL REFERENCES spvs(id) ON DELETE CASCADE,
  parcel_id      bigint NOT NULL REFERENCES parcels(id),
  property_id    uuid REFERENCES properties(id),
  sahm_held      integer NOT NULL CHECK (sahm_held > 0),
  deed_no        text,                        -- رقم سند التسجيل
  registered_on  date,
  acquisition_cost_fils bigint NOT NULL,
  transfer_fees_fils    bigint NOT NULL DEFAULT 0,
  UNIQUE (spv_id, parcel_id, property_id)
);
CREATE INDEX spv_title_parcel_idx ON spv_title_holdings (parcel_id);

-- ------------------------------------------------------------- offerings
CREATE TABLE offerings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spv_id            uuid NOT NULL REFERENCES spvs(id),
  property_id       uuid NOT NULL REFERENCES properties(id),
  status            offering_status NOT NULL DEFAULT 'draft',
  target_raise_fils bigint NOT NULL CHECK (target_raise_fils > 0),
  min_raise_fils    bigint NOT NULL,           -- below this → full refund
  units_offered     bigint NOT NULL CHECK (units_offered > 0),
  unit_price_fils   bigint NOT NULL CHECK (unit_price_fils > 0),
  min_ticket_units  integer NOT NULL DEFAULT 1,
  max_ticket_pct    numeric(5,2) NOT NULL DEFAULT 20.00,  -- concentration cap
  max_investors     integer NOT NULL DEFAULT 50,          -- LLC partner ceiling guard
  opens_at          timestamptz NOT NULL,
  closes_at         timestamptz NOT NULL,
  -- disclosure pack that must exist before status can leave 'draft'
  prospectus_uri    text,
  valuation_uri     text,
  valuer_license_no text,
  jsc_filing_ref    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (min_raise_fils <= target_raise_fils),
  CHECK (closes_at > opens_at)
);
CREATE INDEX offerings_status_idx ON offerings (status, closes_at);

-- Investor orders. Money sits in a segregated escrow account until allocation.
CREATE TABLE investment_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id       uuid NOT NULL REFERENCES offerings(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  units_requested   bigint NOT NULL CHECK (units_requested > 0),
  units_allocated   bigint NOT NULL DEFAULT 0 CHECK (units_allocated >= 0),
  amount_fils       bigint NOT NULL CHECK (amount_fils > 0),
  status            order_status NOT NULL DEFAULT 'pending',
  psp_reference     text,
  cooling_off_ends  timestamptz,               -- statutory withdrawal window
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_id, user_id)
);
CREATE INDEX orders_user_idx ON investment_orders (user_id, status);

-- Cap table. Append-only holdings; current position = SUM(delta_units).
CREATE TABLE share_positions (
  id            bigserial PRIMARY KEY,
  spv_id        uuid NOT NULL REFERENCES spvs(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  delta_units   bigint NOT NULL CHECK (delta_units <> 0),
  reason        text NOT NULL,                 -- primary_allocation|secondary_transfer|buyback|redemption
  order_id      uuid REFERENCES investment_orders(id),
  ccd_filed_at  timestamptz,                   -- date the CCD register was updated
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_positions_spv_user ON share_positions (spv_id, user_id);

CREATE VIEW v_cap_table AS
SELECT spv_id, user_id, SUM(delta_units)::bigint AS units
FROM share_positions GROUP BY spv_id, user_id HAVING SUM(delta_units) > 0;

-- ------------------------------------------- double-entry financial ledger
CREATE TABLE ledger_accounts (
  id        bigserial PRIMARY KEY,
  spv_id    uuid REFERENCES spvs(id),
  user_id   uuid REFERENCES users(id),
  code      text NOT NULL,     -- ESCROW, SPV_CASH, RENT_INCOME, OPEX, MGMT_FEE, INVESTOR_PAYABLE
  name      text NOT NULL,
  UNIQUE (code, spv_id, user_id)
);

CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  txn_id       uuid NOT NULL,                  -- groups a balanced transaction
  account_id   bigint NOT NULL REFERENCES ledger_accounts(id),
  direction    ledger_direction NOT NULL,
  amount_fils  bigint NOT NULL CHECK (amount_fils > 0),
  memo         text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_acct_idx ON ledger_entries (account_id, occurred_at DESC);

-- Enforce that every transaction balances (debits = credits).
CREATE OR REPLACE FUNCTION assert_txn_balanced(p_txn uuid) RETURNS void AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_fils) FILTER (WHERE direction='debit'),0),
         COALESCE(SUM(amount_fils) FILTER (WHERE direction='credit'),0)
    INTO d, c FROM ledger_entries WHERE txn_id = p_txn;
  IF d <> c THEN
    RAISE EXCEPTION 'Unbalanced txn %: debit % != credit %', p_txn, d, c;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TABLE distributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spv_id            uuid NOT NULL REFERENCES spvs(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  gross_rent_fils   bigint NOT NULL DEFAULT 0,
  opex_fils         bigint NOT NULL DEFAULT 0,
  reserve_fils      bigint NOT NULL DEFAULT 0,
  mgmt_fee_fils     bigint NOT NULL DEFAULT 0,
  net_payout_fils   bigint NOT NULL DEFAULT 0,
  paid_at           timestamptz,
  UNIQUE (spv_id, period_start, period_end)
);

CREATE TABLE distribution_lines (
  id              bigserial PRIMARY KEY,
  distribution_id uuid NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  units           bigint NOT NULL,
  amount_fils     bigint NOT NULL CHECK (amount_fils >= 0),
  wht_fils        bigint NOT NULL DEFAULT 0,      -- withholding, if applicable
  UNIQUE (distribution_id, user_id)
);

-- ============================================================= COMMUNITY
CREATE TABLE community_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    uuid NOT NULL REFERENCES users(id),
  admin_area_id bigint REFERENCES admin_areas(id),
  parcel_id    bigint REFERENCES parcels(id),
  body_md      text NOT NULL,
  topic        text NOT NULL DEFAULT 'general',   -- general|price_check|services|dispute|deal
  geom         geometry(Point,4326) NOT NULL,
  -- posts are visible to users whose home_point is within this radius
  visibility_radius_m integer NOT NULL DEFAULT 1500,
  score        integer NOT NULL DEFAULT 0,
  is_hidden    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_posts_gix ON community_posts USING GIST (geom);
CREATE INDEX community_posts_area ON community_posts (admin_area_id, created_at DESC);

CREATE TABLE community_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body_md    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_comments_post ON community_comments (post_id, created_at);

-- Immutable audit trail — required evidence for JSC/CMA and CBJ AML reviews.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  ip          inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, occurred_at DESC);

COMMIT;
