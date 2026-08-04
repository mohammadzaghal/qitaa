/**
 * Money in Jordanian Dinar, stored as integer *fils*. 1 JOD = 1000 fils.
 *
 * Rule: no floating point ever touches a monetary value. Every amount that
 * crosses a process boundary is a bigint of fils. Percentages are basis points.
 */
export type Fils = bigint;

export const FILS_PER_JOD = 1000n;

export function jod(amount: number): Fils {
  // Accepts up to 3 decimal places; anything finer is a caller bug.
  const scaled = Math.round(amount * 1000);
  if (!Number.isFinite(scaled)) throw new RangeError(`invalid JOD amount: ${amount}`);
  if (Math.abs(amount * 1000 - scaled) > 1e-6) {
    throw new RangeError(`JOD amount ${amount} has sub-fils precision`);
  }
  return BigInt(scaled);
}

export function formatJOD(f: Fils, locale = "en-JO"): string {
  const neg = f < 0n;
  const abs = neg ? -f : f;
  const whole = abs / FILS_PER_JOD;
  const frac = (abs % FILS_PER_JOD).toString().padStart(3, "0");
  const grouped = new Intl.NumberFormat(locale).format(whole);
  return `${neg ? "-" : ""}${grouped}.${frac} JD`;
}

/** Basis points: 10_000 bps = 100%. */
export type Bps = number;

/** floor(amount * bps / 10000) — always rounds in favour of the pool. */
export function applyBps(amount: Fils, bps: Bps): Fils {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bad bps: ${bps}`);
  return (amount * BigInt(bps)) / 10_000n;
}

export function sum(xs: readonly Fils[]): Fils {
  return xs.reduce((a, b) => a + b, 0n);
}
