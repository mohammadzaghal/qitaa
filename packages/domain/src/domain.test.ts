import { describe, expect, it } from "vitest";
import { applyBps, formatJOD, jod, sum } from "./money.js";
import { allocateProRata, unitsToM2, m2PerSahm } from "./shares.js";
import { netYieldBps, runWaterfall } from "./waterfall.js";

describe("money", () => {
  it("converts JOD to fils exactly", () => {
    expect(jod(300)).toBe(300_000n);
    expect(jod(0.001)).toBe(1n);
    expect(() => jod(0.0001)).toThrow();
  });
  it("formats with three decimals like a Jordanian bank statement", () => {
    expect(formatJOD(300_000n)).toBe("300.000 JD");
    expect(formatJOD(1_234_567n)).toBe("1,234.567 JD");
  });
  it("applyBps floors in favour of the pool", () => {
    expect(applyBps(1_000_001n, 1000)).toBe(100_000n); // 10%
  });
});

describe("allocateProRata", () => {
  const price = jod(10); // 10 JD per unit

  it("fills everyone when undersubscribed", () => {
    const out = allocateProRata(
      [
        { userId: "a", unitsRequested: 30n, amountPaidFils: jod(300), createdAt: 1 },
        { userId: "b", unitsRequested: 10n, amountPaidFils: jod(100), createdAt: 2 },
      ],
      1000n, price,
    );
    expect(out.map((o) => o.unitsAllocated)).toEqual([30n, 10n]);
    expect(sum(out.map((o) => o.refundFils))).toBe(0n);
  });

  it("conserves units exactly when oversubscribed", () => {
    const orders = Array.from({ length: 97 }, (_, i) => ({
      userId: `u${i}`,
      unitsRequested: BigInt(i + 1),
      amountPaidFils: BigInt(i + 1) * price,
      createdAt: i,
    }));
    const offered = 500n;
    const out = allocateProRata(orders, offered, price);
    expect(sum(out.map((o) => o.unitsAllocated))).toBe(offered);
    // nobody gets more than they asked for, nobody gets negative refund
    for (const o of out) {
      expect(o.unitsAllocated <= o.unitsRequested).toBe(true);
      expect(o.refundFils >= 0n).toBe(true);
      expect(o.amountDueFils).toBe(o.unitsAllocated * price);
    }
  });

  it("enforces the concentration cap", () => {
    const out = allocateProRata(
      [
        { userId: "whale", unitsRequested: 900n, amountPaidFils: jod(9000), createdAt: 1 },
        { userId: "small", unitsRequested: 100n, amountPaidFils: jod(1000), createdAt: 2 },
      ],
      1000n, price, 20, // max 20% = 200 units
    );
    expect(out[0]!.unitsAllocated).toBe(200n);
    expect(out[0]!.refundFils).toBe(jod(7000));
    expect(out[1]!.unitsAllocated).toBe(100n);
  });

  it("is deterministic — same input, same allocation", () => {
    const orders = Array.from({ length: 40 }, (_, i) => ({
      userId: `u${i}`, unitsRequested: 7n, amountPaidFils: jod(70), createdAt: i,
    }));
    const a = allocateProRata(orders, 111n, price);
    const b = allocateProRata([...orders].reverse(), 111n, price);
    const key = (x: typeof a) => new Map(x.map((o) => [o.userId, o.unitsAllocated]));
    expect(key(a)).toEqual(key(b));
  });
});

describe("sahm ↔ m² reconciliation", () => {
  it("a 1200 m² plot at 2400 sahm is 0.5 m² per sahm", () => {
    expect(m2PerSahm(1200)).toBe(0.5);
  });
  it("300 JD at 10 JD/unit in a 500k JD SPV maps to a real m² figure", () => {
    // SPV holds all 2400 sahm of a 1200 m² plot, 50,000 units issued
    const m2 = unitsToM2(30n, 50_000n, 2400, 1200);
    expect(m2).toBeCloseTo(0.72, 6);
  });
});

describe("waterfall", () => {
  const cfg = { reserveBps: 500, reserveCapFils: jod(20_000), mgmtFeeBps: 1000 };

  it("balances to the fil and sweeps dust to reserve", () => {
    const holders = [
      { userId: "a", units: 333n },
      { userId: "b", units: 333n },
      { userId: "c", units: 334n },
    ];
    const r = runWaterfall({
      grossRentFils: jod(1000),
      opexFils: jod(120.5),
      taxFils: jod(30),
      reserveBalanceFils: 0n,
      config: cfg,
      holders,
    });
    expect(r.noiFils).toBe(jod(849.5));
    expect(r.reserveContributionFils).toBe(jod(42.475));
    expect(sum(r.lines.map((l) => l.amountFils)) + r.dustToReserveFils).toBe(r.distributableFils);
    expect(r.dustToReserveFils >= 0n).toBe(true);
  });

  it("stops funding the reserve once capped", () => {
    const r = runWaterfall({
      grossRentFils: jod(1000), opexFils: 0n, taxFils: 0n,
      reserveBalanceFils: jod(19_990),
      config: cfg,
      holders: [{ userId: "a", units: 1n }],
    });
    expect(r.reserveContributionFils).toBe(jod(10)); // headroom only
  });

  it("never distributes on a loss-making period", () => {
    const r = runWaterfall({
      grossRentFils: jod(100), opexFils: jod(400), taxFils: 0n,
      reserveBalanceFils: 0n, config: cfg,
      holders: [{ userId: "a", units: 1n }],
    });
    expect(r.noiFils).toBe(0n);
    expect(r.distributableFils).toBe(0n);
  });

  it("computes annualised net yield in bps", () => {
    // 300 JD invested, 4.5 JD/quarter net → 6% net yield
    expect(netYieldBps(jod(4.5), jod(300), 4)).toBe(600);
  });
});
