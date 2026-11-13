import type { BrandScout, BrandVerdict } from "@/db/schema";

export const SCOUT_STATUS: Record<BrandScout["status"], { label: string; cls: string }> = {
  queued: { label: "У черзі", cls: "muted" },
  running: { label: "Збираю", cls: "risk-medium" },
  done: { label: "Готово", cls: "risk-low" },
  failed: { label: "Помилка", cls: "risk-high" },
};

export const VERDICT: Record<BrandVerdict, { label: string; cls: string }> = {
  brand: { label: "бренд", cls: "risk-low" },
  unsure: { label: "перевірте", cls: "risk-medium" },
  not_brand: { label: "не бренд", cls: "muted" },
};
