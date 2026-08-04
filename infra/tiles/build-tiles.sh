#!/usr/bin/env bash
# =============================================================================
# Spatial data pipeline: OSM/DLS source -> GeoParquet -> MBTiles -> PMTiles
#
# Output is a single .pmtiles archive uploaded to S3/R2. The browser reads it
# with HTTP range requests via the pmtiles protocol handler — no tile server,
# no per-tile invocation cost, and it works from a static CDN origin.
#
# Requires: gdal (ogr2ogr), tippecanoe >= 2.40, pmtiles CLI, duckdb.
# =============================================================================
set -euo pipefail

OUT_DIR="${OUT_DIR:-data/tiles}"
RAW_DIR="${RAW_DIR:-data/raw}"
mkdir -p "$OUT_DIR" "$RAW_DIR"

# --- 1. Buildings (3D massing context) --------------------------------------
# Geofabrik Jordan extract; filter to building polygons with height/levels.
if [ ! -f "$RAW_DIR/jordan-latest.osm.pbf" ]; then
  curl -L -o "$RAW_DIR/jordan-latest.osm.pbf" \
    https://download.geofabrik.de/asia/jordan-latest.osm.pbf
fi

ogr2ogr -f GeoJSONSeq "$RAW_DIR/buildings.geojsonl" \
  "$RAW_DIR/jordan-latest.osm.pbf" multipolygons \
  -where "building IS NOT NULL" \
  -sql "SELECT building AS class,
               CAST(COALESCE(height, CAST(building_levels AS character(10))) AS float) AS height_m,
               building_levels AS levels
        FROM multipolygons WHERE building IS NOT NULL"

tippecanoe -o "$OUT_DIR/jordan-buildings.mbtiles" \
  --layer=building \
  --minimum-zoom=13 --maximum-zoom=16 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping \
  --no-tile-size-limit --force \
  "$RAW_DIR/buildings.geojsonl"

pmtiles convert "$OUT_DIR/jordan-buildings.mbtiles" "$OUT_DIR/jordan-buildings.pmtiles"

# --- 2. Cadastral parcels ----------------------------------------------------
# DLS supplies Jordan Transverse Mercator. Reproject to 4326 on ingest so every
# downstream consumer sees one CRS. EPSG:30791 = Jordan / JTM.
if [ -f "$RAW_DIR/dls_parcels.shp" ]; then
  ogr2ogr -f Parquet "$RAW_DIR/parcels.parquet" "$RAW_DIR/dls_parcels.shp" \
    -s_srs EPSG:30791 -t_srs EPSG:4326 -nlt POLYGON -lco COMPRESSION=ZSTD

  # DuckDB spatial does the join + attribute shaping before tiling. The same
  # .parquet is later loaded into the browser by DuckDB-WASM for offline
  # analytics (comparables, price-per-m² histograms) without an API round trip.
  duckdb -c "
    INSTALL spatial; LOAD spatial;
    COPY (
      SELECT village_no AS dls_village, basin_no AS dls_basin, plot_no AS dls_plot,
             area_m2, zoning, ST_AsWKB(geom) AS geometry
      FROM read_parquet('$RAW_DIR/parcels.parquet')
    ) TO '$OUT_DIR/parcels.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
  "

  ogr2ogr -f GeoJSONSeq "$RAW_DIR/parcels.geojsonl" "$RAW_DIR/parcels.parquet"
  tippecanoe -o "$OUT_DIR/jordan-parcels.mbtiles" \
    --layer=parcel --minimum-zoom=14 --maximum-zoom=16 \
    --no-simplification-of-shared-nodes --detect-shared-borders \
    --force "$RAW_DIR/parcels.geojsonl"
  pmtiles convert "$OUT_DIR/jordan-parcels.mbtiles" "$OUT_DIR/jordan-parcels.pmtiles"
fi

# --- 3. Upload ---------------------------------------------------------------
# PMTiles archives are immutable; version them by date and flip the client
# pointer atomically so a bad tile build never half-deploys.
STAMP=$(date +%Y%m%d)
for f in "$OUT_DIR"/*.pmtiles; do
  aws s3 cp "$f" "s3://${S3_BUCKET:-qitaa-tiles}/$STAMP/$(basename "$f")" \
    --cache-control "public, max-age=31536000, immutable"
done

echo "built: $STAMP"
