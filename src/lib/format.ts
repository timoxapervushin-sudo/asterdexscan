export function money(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function number(value?: number | null, max = 6) {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function pct(value?: number | string | null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function time(value?: number | null) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString();
}

export function sideClass(side?: string) {
  const s = String(side || "").toLowerCase();
  if (s.includes("long") || s.includes("buy")) return "positive";
  if (s.includes("short") || s.includes("sell")) return "negative";
  return "";
}
