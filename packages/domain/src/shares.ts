import type { Fils } from "./money.js";

/**
 * DLS registers ownership of a parcel in *sahm* (أسهم) — conventionally 2400
 * per plot — not in square metres. "One square metre of land" is therefore a
 * marketing abstraction over a sahm fraction. These helpers keep the two
 * representations reconcilable so a user-facing "you own 12 m²" claim can
 * always be traced to an exact integer sahm position on the title deed.
 */
export const DEFAULT_TOTAL_SAHM = 2400;

export function m2PerSahm(registeredAreaM2: number, totalSahm = DEFAULT_TOTAL_SAHM): number {
  if (registeredAreaM2 <= 0 || totalSahm <= 0) throw new RangeError("bad parcel dimensions");
  return registeredAreaM2 / totalSahm;
}

/** Equivalent m² of an SPV unit position, for display only. Never for settlement. */
export function unitsToM2(
  units: bigint,
  totalUnits: bigint,
  sahmHeld: number,
  registeredAreaM2: number,
  totalSahm = DEFAULT_TOTAL_SAHM,
): number {
  if (totalUnits <= 0n) throw new RangeError("totalUnits must be positive");
  const spvAreaM2 = registeredAreaM2 * (sahmHeld / totalSahm);
  return (Number(units) / Number(totalUnits)) * spvAreaM2;
}

export interface Allocation {
  userId: string;
  unitsRequested: bigint;
  unitsAllocated: bigint;
  amountDueFils: Fils;
  refundFils: Fils;
}

export interface AllocationInput {
  userId: string;
  unitsRequested: bigint;
  amountPaidFils: Fils;
  createdAt: number; // epoch ms — used as the deterministic tie-break
}

/**
 * Pro-rata allocation with largest-remainder settlement.
 *
 * Oversubscription is the normal case for a good deal, and "first come first
 * served" produces bot-farming. We scale everyone down proportionally, then
 * hand out the leftover integer units by descending fractional remainder,
 * breaking ties by earliest order. The result is deterministic and replayable,
 * which is what an auditor will ask for.
 *
 * Invariant: sum(unitsAllocated) === min(unitsOffered, sum(eligible)).
 */
export function allocateProRata(
  orders: readonly AllocationInput[],
  unitsOffered: bigint,
  unitPriceFils: Fils,
  maxTicketPct = 100,
): Allocation[] {
  if (unitsOffered <= 0n) throw new RangeError("unitsOffered must be positive");

  const cap = (BigInt(Math.round(maxTicketPct * 100)) * unitsOffered) / 10_000n;
  const capped = orders.map((o) => ({
    ...o,
    eligible: cap > 0n && o.unitsRequested > cap ? cap : o.unitsRequested,
  }));

  const demand = capped.reduce((a, o) => a + o.eligible, 0n);
  const toAllocate = demand < unitsOffered ? demand : unitsOffered;

  const base = capped.map((o) => ({
    ...o,
    floorUnits: demand === 0n ? 0n : (o.eligible * toAllocate) / demand,
    remainder: demand === 0n ? 0n : (o.eligible * toAllocate) % demand,
  }));

  let leftover = toAllocate - base.reduce((a, o) => a + o.floorUnits, 0n);

  const ranked = [...base].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.userId < b.userId ? -1 : 1;
  });

  const bonus = new Map<string, bigint>();
  for (const o of ranked) {
    if (leftover <= 0n) break;
    if (o.floorUnits >= o.eligible) continue; // never exceed what was requested
    bonus.set(o.userId, 1n);
    leftover -= 1n;
  }

  return base.map((o) => {
    const units = o.floorUnits + (bonus.get(o.userId) ?? 0n);
    const due = units * unitPriceFils;
    return {
      userId: o.userId,
      unitsRequested: o.unitsRequested,
      unitsAllocated: units,
      amountDueFils: due,
      refundFils: o.amountPaidFils - due,
    };
  });
}
