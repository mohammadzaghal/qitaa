export interface ParcelProps {
  id: string;
  /** DLS addressing: village / basin (حوض) / plot (قطعة) */
  dls: { village: number; basin: number; plot: number };
  neighbourhood_en: string;
  neighbourhood_ar: string;
  type: "land" | "villa" | "apartment" | "building";
  area_m2: number;
  /** administrative (DLS) value per m², in fils */
  admin_value_fils_m2: number;
  /** last observed market asking price per m², in fils */
  market_value_fils_m2: number;
  height_m: number;
  /** null when the parcel is not part of a live co-investment offering */
  offering: {
    id: string;
    spv_name: string;
    unit_price_fils: number;
    units_offered: number;
    units_sold: number;
    target_net_yield_bps: number;
    closes_at: string;
  } | null;
}
