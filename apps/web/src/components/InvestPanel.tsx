"use client";

import { useMemo, useState } from "react";
import { jod, netYieldBps, runWaterfall, unitsToM2 } from "@qitaa/domain";
import type { ParcelProps } from "@/lib/types";
import { fmtJOD, pct } from "@/lib/format";

const TICKETS = [300, 500, 1000, 2500];

export function InvestPanel({ parcel, onClose }: { parcel: ParcelProps; onClose: () => void }) {
  const [ticketJOD, setTicketJOD] = useState(300);
  const o = parcel.offering;

  const model = useMemo(() => {
    if (!o) return null;
    const unitPrice = BigInt(o.unit_price_fils);
    const units = jod(ticketJOD) / unitPrice;
    const invested = units * unitPrice;

    // Equivalent land area, traced back to the SPV's registered sahm position.
    const m2 = unitsToM2(units, BigInt(o.units_offered), 2400, parcel.area_m2);

    // Quarterly cash model at the offering's target gross yield.
    const annualGross = (invested * BigInt(o.target_net_yield_bps + 450)) / 10_000n;
    const q = runWaterfall({
      grossRentFils: annualGross / 4n,
      opexFils: (annualGross / 4n) * 18n / 100n,
      taxFils: (annualGross / 4n) * 3n / 100n,
      reserveBalanceFils: 0n,
      config: { reserveBps: 500, reserveCapFils: jod(50_000), mgmtFeeBps: 1000 },
      holders: [{ userId: "me", units }],
    });
    const myQuarterly = q.lines[0]?.amountFils ?? 0n;

    return {
      units,
      invested,
      m2,
      myQuarterly,
      realisedYieldBps: netYieldBps(myQuarterly, invested, 4),
      dust: invested === jod(ticketJOD) ? 0n : jod(ticketJOD) - invested,
    };
  }, [o, ticketJOD, parcel.area_m2]);

  const fillPct = o ? Math.round((o.units_sold / Math.max(o.units_offered, 1)) * 100) : 0;

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-dvh w-full max-w-md flex-col overflow-y-auto border-l border-white/5 bg-basalt-900/95 backdrop-blur-xl">
      <div className="flex items-start justify-between p-5 pb-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-sand-300/50">
            {parcel.type} · {parcel.neighbourhood_en}
          </p>
          <h2 className="mt-1 text-xl font-semibold" dir="rtl">
            {parcel.neighbourhood_ar}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-sand-300/50">
            قرية {parcel.dls.village} · حوض {parcel.dls.basin} · قطعة {parcel.dls.plot}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-2 text-sand-300/50 transition hover:bg-white/5 hover:text-sand-100"
        >
          ✕
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-white/5 bg-white/5">
        <Stat label="Registered area" value={`${parcel.area_m2.toLocaleString()} m²`} />
        <Stat label="Asking / m²" value={fmtJOD(parcel.market_value_fils_m2)} />
        <Stat label="DLS admin value / m²" value={fmtJOD(parcel.admin_value_fils_m2)} />
        <Stat
          label="Value gap"
          value={`${(parcel.market_value_fils_m2 / Math.max(parcel.admin_value_fils_m2, 1)).toFixed(2)}×`}
        />
      </dl>

      {!o ? (
        <div className="p-5">
          <p className="text-sm text-sand-300/70">
            No live co-investment offering on this parcel. It is listed for direct sale or rent
            only.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-5">
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold">{o.spv_name}</h3>
              <span className="text-xs text-sand-300/60">{fillPct}% funded</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-petra-500 transition-all"
                style={{ width: `${fillPct}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-sand-300/50">
              LLC SPV registered at the Companies Control Department · holds 2,400/2,400 sahm of
              this plot · closes {new Date(o.closes_at).toLocaleDateString("en-GB")}
            </p>
          </section>

          <section>
            <p className="mb-2 text-[10px] uppercase tracking-widest text-sand-300/50">
              Your ticket
            </p>
            <div className="flex gap-2">
              {TICKETS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTicketJOD(t)}
                  className={`flex-1 rounded-lg px-2 py-2 text-sm font-medium transition ${
                    ticketJOD === t
                      ? "bg-petra-500 text-white"
                      : "bg-white/5 text-sand-300/70 hover:bg-white/10"
                  }`}
                >
                  {t} JD
                </button>
              ))}
            </div>
          </section>

          {model && (
            <section className="rounded-xl bg-white/[0.04] p-4">
              <Row label="Units at {p}" value={`${model.units.toString()} units`}
                   sub={fmtJOD(o.unit_price_fils) + " / unit"} />
              <Row label="Capital deployed" value={fmtJOD(model.invested)} />
              <Row
                label="Equivalent land"
                value={`${model.m2.toFixed(2)} m²`}
                sub="traced to the SPV's registered sahm"
              />
              <div className="my-3 h-px bg-white/10" />
              <Row label="Est. quarterly payout" value={fmtJOD(model.myQuarterly)} />
              <Row
                label="Net yield (annualised)"
                value={pct(model.realisedYieldBps)}
                sub="after opex, tax, 5% reserve, 10% mgmt fee"
                accent
              />
              {model.dust > 0n && (
                <p className="mt-3 text-[11px] text-sand-300/50">
                  {fmtJOD(model.dust)} returned — units are indivisible.
                </p>
              )}
            </section>
          )}

          <button className="rounded-xl bg-petra-500 py-3 text-sm font-semibold text-white transition hover:bg-petra-600">
            Reserve {ticketJOD} JD
          </button>
          <p className="text-[10px] leading-relaxed text-sand-300/40">
            Demo interface. Capital at risk; real-estate returns are not guaranteed. A live
            offering requires a licensed equity-crowdfunding permission under the amended
            Securities Law and KYC/AML checks under CBJ rules. Funds would be held in a
            segregated escrow account and refunded in full if the minimum raise is not met.
          </p>
        </div>
      )}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-basalt-900 p-4">
      <dt className="text-[10px] uppercase tracking-wider text-sand-300/50">{label}</dt>
      <dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Row({
  label, value, sub, accent,
}: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="flex items-start justify-between py-1.5">
      <div>
        <p className="text-xs text-sand-300/70">{label.replace("{p}", "offer price")}</p>
        {sub && <p className="text-[10px] text-sand-300/40">{sub}</p>}
      </div>
      <p className={`text-sm font-semibold tabular-nums ${accent ? "text-petra-400" : ""}`}>
        {value}
      </p>
    </div>
  );
}
