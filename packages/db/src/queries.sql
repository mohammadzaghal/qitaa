-- ============================================================================
-- The four spatial queries that carry the product. Each is written to hit a
-- GiST index; run EXPLAIN (ANALYZE, BUFFERS) after every schema change.
-- ============================================================================

-- 1. Map viewport fetch. ST_MakeEnvelope + && is index-assisted; ST_Intersects
--    is the exact recheck. LIMIT protects the API from a zoomed-out request.
-- $1..$4 = west, south, east, north  $5 = zoom
SELECT p.id, p.dls_plot_no, p.registered_area_m2,
       ST_AsGeoJSON(p.geom, 6)::json AS geometry,
       o.id AS offering_id, o.unit_price_fils, o.units_offered
FROM parcels p
LEFT JOIN properties pr ON pr.parcel_id = p.id
LEFT JOIN offerings  o  ON o.property_id = pr.id AND o.status = 'open'
WHERE p.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  AND ST_Intersects(p.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
ORDER BY p.registered_area_m2 DESC
LIMIT CASE WHEN $5 < 14 THEN 500 ELSE 4000 END;

-- 2. Hyperlocal community feed: posts whose own visibility radius contains me.
--    ST_DWithin on geography gives true metres and still uses the GiST index.
-- $1 = user home point (geometry 4326)
SELECT cp.id, cp.body_md, cp.topic, cp.created_at,
       ST_Distance(cp.geom::geography, $1::geography) AS distance_m
FROM community_posts cp
WHERE NOT cp.is_hidden
  AND ST_DWithin(cp.geom::geography, $1::geography, cp.visibility_radius_m)
ORDER BY cp.created_at DESC
LIMIT 50;

-- 3. Comparable-sales valuation support: median asking price per m² for
--    parcels of the same type within 800 m, excluding the subject parcel.
-- $1 = parcel_id
WITH subject AS (SELECT centroid, id FROM parcels WHERE id = $1)
SELECT pr.type,
       count(*) AS n,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY l.price_fils / NULLIF(pr.area_m2, 0)
       ) AS median_fils_per_m2
FROM subject s
JOIN parcels p2   ON p2.id <> s.id
                 AND ST_DWithin(p2.centroid::geography, s.centroid::geography, 800)
JOIN properties pr ON pr.parcel_id = p2.id
JOIN listings l    ON l.property_id = pr.id AND l.kind = 'sale' AND l.status = 'active'
GROUP BY pr.type
HAVING count(*) >= 3;   -- never publish a comp set thinner than three sales

-- 4. Cap-table reconciliation. Must equal the CCD shareholder register and the
--    SPV's sahm position on the title deed. Run nightly; alert on any drift.
SELECT s.id AS spv_id, s.name_en,
       s.total_units,
       COALESCE(SUM(sp.delta_units), 0) AS units_issued,
       s.total_units - COALESCE(SUM(sp.delta_units), 0) AS treasury_units,
       (SELECT SUM(sahm_held) FROM spv_title_holdings WHERE spv_id = s.id) AS sahm_on_title
FROM spvs s
LEFT JOIN share_positions sp ON sp.spv_id = s.id
GROUP BY s.id
HAVING COALESCE(SUM(sp.delta_units), 0) > s.total_units;  -- over-issuance alarm
