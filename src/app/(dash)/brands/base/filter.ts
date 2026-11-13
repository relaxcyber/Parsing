import type { BaseFilter } from "@/brands";

export type BaseParams = { q?: string; size?: string; min?: string; email?: string; show?: string; msg?: string };

/** «8k», «12 000», «1.2m» → число підписників. */
export function parseCount(v: string | undefined): number | null {
  const m = (v ?? "").trim().toLowerCase().replace(/[\s,]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1));
}

export function filterOf(p: BaseParams): BaseFilter {
  return {
    q: p.q?.slice(0, 100), size: parseCount(p.size), min: Math.max(1, Math.min(10, Number(p.min) || 1)), emailOnly: p.email === "on",
    show: p.show === "checked" || p.show === "unchecked" ? p.show : "all",
  };
}

export const queryOf = (p: BaseParams) =>
  new URLSearchParams(Object.entries(p).filter(([k, v]) => k !== "msg" && v) as [string, string][]).toString();
