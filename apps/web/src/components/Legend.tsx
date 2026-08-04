"use client";

const SCALES = {
  invest: {
    title: "Offering fill",
    stops: [
      ["#2c3340", "no live offering"],
      ["#3f7d6a", "0–25% funded"],
      ["#8fae54", "25–75%"],
      ["#e0855f", "75–95%"],
      ["#c96a44", "closing"],
    ],
  },
  market: {
    title: "Asking price / m²",
    stops: [
      ["#2c3340", "< 150 JD"],
      ["#5c6b8a", "400 JD"],
      ["#c96a44", "800 JD"],
      ["#f0a071", "1,500 JD+"],
    ],
  },
  gap: {
    title: "Market ÷ DLS administrative value",
    stops: [
      ["#2c3340", "1.0× (at book)"],
      ["#5c6b8a", "1.6×"],
      ["#c96a44", "2.4×"],
      ["#ff7a45", "3.5×+"],
    ],
  },
} as const;

export function Legend({ mode }: { mode: keyof typeof SCALES }) {
  const scale = SCALES[mode];
  return (
    <div className="absolute bottom-6 left-4 z-10 rounded-xl bg-basalt-900/85 p-3 backdrop-blur">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-sand-300/60">
        {scale.title}
      </p>
      <ul className="space-y-1">
        {scale.stops.map(([color, label]) => (
          <li key={label} className="flex items-center gap-2 text-[11px] text-sand-300/80">
            <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
