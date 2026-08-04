import Fastify from "fastify";
import postgres from "postgres";
import { z } from "zod";
import { allocateProRata, jod, runWaterfall } from "@qitaa/domain";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://qitaa:qitaa@localhost:5432/qitaa", {
  transform: postgres.camel,
  max: 10,
});

const app = Fastify({ logger: true });

const bboxQuery = z.object({
  w: z.coerce.number().min(-180).max(180),
  s: z.coerce.number().min(-90).max(90),
  e: z.coerce.number().min(-180).max(180),
  n: z.coerce.number().min(-90).max(90),
  z: z.coerce.number().min(0).max(22).default(14),
});

/**
 * Viewport parcel fetch. Returns GeoJSON directly from PostGIS so the payload
 * never round-trips through a JS serialiser. Above z14 we cap at 4k features;
 * below that the client should be reading PMTiles, not the API.
 */
app.get("/parcels", async (req, reply) => {
  const q = bboxQuery.parse(req.query);
  if (q.z < 13) {
    return reply.code(400).send({ error: "zoom too low — use the PMTiles basemap layer" });
  }
  const rows = await sql`
    SELECT json_build_object(
      'type','FeatureCollection',
      'features', COALESCE(json_agg(f.feature), '[]'::json)
    ) AS fc
    FROM (
      SELECT json_build_object(
        'type','Feature',
        'id', p.id,
        'geometry', ST_AsGeoJSON(p.geom, 6)::json,
        'properties', json_build_object(
          'id', p.id,
          'dls_village', p.dls_village_no,
          'dls_basin',   p.dls_basin_no,
          'dls_plot',    p.dls_plot_no,
          'area_m2',     p.registered_area_m2,
          'offering_id', o.id,
          'unit_price_fils', o.unit_price_fils,
          'units_offered',   o.units_offered
        )
      ) AS feature
      FROM parcels p
      LEFT JOIN properties pr ON pr.parcel_id = p.id
      LEFT JOIN offerings  o  ON o.property_id = pr.id AND o.status = 'open'
      WHERE p.geom && ST_MakeEnvelope(${q.w}, ${q.s}, ${q.e}, ${q.n}, 4326)
        AND ST_Intersects(p.geom, ST_MakeEnvelope(${q.w}, ${q.s}, ${q.e}, ${q.n}, 4326))
      LIMIT 4000
    ) f`;
  return rows[0]?.fc ?? { type: "FeatureCollection", features: [] };
});

/**
 * Close an offering: allocate units pro rata, write the cap table and the
 * refund instructions in one transaction. Idempotent on offering id.
 */
app.post<{ Params: { id: string } }>("/offerings/:id/close", async (req, reply) => {
  const offeringId = z.string().uuid().parse(req.params.id);

  return sql.begin(async (tx) => {
    const [offering] = await tx`
      SELECT id, units_offered, unit_price_fils, min_raise_fils, max_ticket_pct, spv_id, status
      FROM offerings WHERE id = ${offeringId} FOR UPDATE`;
    if (!offering) return reply.code(404).send({ error: "offering not found" });
    if (offering.status !== "open") return reply.code(409).send({ error: "offering not open" });

    const orders = await tx`
      SELECT id, user_id, units_requested, amount_fils, extract(epoch from created_at)*1000 AS created_ms
      FROM investment_orders
      WHERE offering_id = ${offeringId} AND status = 'escrowed'`;

    const raised = orders.reduce((a, o) => a + BigInt(o.amountFils), 0n);
    if (raised < BigInt(offering.minRaiseFils)) {
      await tx`UPDATE investment_orders SET status='refunded' WHERE offering_id=${offeringId}`;
      await tx`UPDATE offerings SET status='failed' WHERE id=${offeringId}`;
      return { outcome: "failed", refunded: raised.toString() };
    }

    const allocations = allocateProRata(
      orders.map((o) => ({
        userId: o.userId as string,
        unitsRequested: BigInt(o.unitsRequested),
        amountPaidFils: BigInt(o.amountFils),
        createdAt: Number(o.createdMs),
      })),
      BigInt(offering.unitsOffered),
      BigInt(offering.unitPriceFils),
      Number(offering.maxTicketPct),
    );

    for (const a of allocations) {
      const order = orders.find((o) => o.userId === a.userId)!;
      await tx`
        UPDATE investment_orders
        SET units_allocated = ${a.unitsAllocated}, status = 'allocated'
        WHERE id = ${order.id}`;
      if (a.unitsAllocated > 0n) {
        await tx`
          INSERT INTO share_positions (spv_id, user_id, delta_units, reason, order_id)
          VALUES (${offering.spvId}, ${a.userId}, ${a.unitsAllocated}, 'primary_allocation', ${order.id})`;
      }
    }
    await tx`UPDATE offerings SET status='funded' WHERE id=${offeringId}`;
    return {
      outcome: "funded",
      allocated: allocations.reduce((a, x) => a + x.unitsAllocated, 0n).toString(),
      refunds: allocations.filter((a) => a.refundFils > 0n).length,
    };
  });
});

/** Preview a quarterly distribution without writing anything. */
app.post<{ Body: unknown }>("/spvs/:id/distributions/preview", async (req) => {
  const body = z.object({
    grossRentJOD: z.number().positive(),
    opexJOD: z.number().min(0),
    taxJOD: z.number().min(0),
    reserveBalanceJOD: z.number().min(0),
    holders: z.array(z.object({ userId: z.string(), units: z.coerce.bigint() })),
  }).parse(req.body);

  return runWaterfall({
    grossRentFils: jod(body.grossRentJOD),
    opexFils: jod(body.opexJOD),
    taxFils: jod(body.taxJOD),
    reserveBalanceFils: jod(body.reserveBalanceJOD),
    config: { reserveBps: 500, reserveCapFils: jod(50_000), mgmtFeeBps: 1000 },
    holders: body.holders,
  });
});

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
