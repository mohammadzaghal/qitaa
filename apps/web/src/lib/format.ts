export function fmtJOD(fils: number | bigint, opts: { compact?: boolean } = {}): string {
  const n = Number(fils) / 1000;
  if (opts.compact && n >= 1000) {
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n / 1000)}k JD`;
  }
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: n < 100 ? 3 : 0 }).format(n)} JD`;
}
export const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
