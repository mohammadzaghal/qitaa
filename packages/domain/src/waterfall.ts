import { applyBps, sum, type Bps, type Fils } from "./money.js";

/**
 * Rental distribution waterfall for a single SPV period.
 *
 * Order is fixed by the SPV's articles of association:
 *   gross rent
 *     − operating expenses (service charge, maintenance, insurance)
 *     − municipality / property tax accrual
 *     → net operating income (NOI)
 *     − CAPEX reserve (bps of NOI, capped at a target balance)
 *     − platform management fee (bps of post-reserve NOI)
 *     → distributable cash, split pro rata by units held.
 *
 * The integer-division remainder is swept into the reserve rather than
 * silently vanishing, so the ledger balances to the fil.
 */
export interface WaterfallConfig {
  reserveBps: Bps;      // 500 = 5% of NOI
  reserveCapFils: Fils; // stop funding the reserve above this balance
  mgmtFeeBps: Bps;      // 1000 = 10%
}

export interface WaterfallInput {
  grossRentFils: Fils;
  opexFils: Fils;
  taxFils: Fils;
  reserveBalanceFils: Fils;
  config: WaterfallConfig;
  holders: readonly { userId: string; units: bigint }[];
}

export interface WaterfallResult {
  noiFils: Fils;
  reserveContributionFils: Fils;
  mgmtFeeFils: Fils;
  distributableFils: Fils;
  dustToReserveFils: Fils;
  lines: { userId: string; units: bigint; amountFils: Fils }[];
}

export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const { grossRentFils, opexFils, taxFils, reserveBalanceFils, config, holders } = input;

  const noiRaw = grossRentFils - opexFils - taxFils;
  const noi = noiRaw > 0n ? noiRaw : 0n;

  const headroom = config.reserveCapFils - reserveBalanceFils;
  const wanted = applyBps(noi, config.reserveBps);
  const reserve = headroom <= 0n ? 0n : wanted > headroom ? headroom : wanted;

  const afterReserve = noi - reserve;
  const mgmtFee = applyBps(afterReserve, config.mgmtFeeBps);
  const distributable = afterReserve - mgmtFee;

  const totalUnits = holders.reduce((a, h) => a + h.units, 0n);
  if (totalUnits === 0n) {
    return {
      noiFils: noi,
      reserveContributionFils: reserve,
      mgmtFeeFils: mgmtFee,
      distributableFils: 0n,
      dustToReserveFils: distributable,
      lines: [],
    };
  }

  const lines = holders.map((h) => ({
    userId: h.userId,
    units: h.units,
    amountFils: (distributable * h.units) / totalUnits,
  }));

  return {
    noiFils: noi,
    reserveContributionFils: reserve,
    mgmtFeeFils: mgmtFee,
    distributableFils: distributable,
    dustToReserveFils: distributable - sum(lines.map((l) => l.amountFils)),
    lines,
  };
}

/** Annualised net yield in basis points, from one period's result. */
export function netYieldBps(
  distributableFils: Fils,
  investedCapitalFils: Fils,
  periodsPerYear: number,
): number {
  if (investedCapitalFils <= 0n) return 0;
  return Number((distributableFils * BigInt(periodsPerYear) * 10_000n) / investedCapitalFils);
}
