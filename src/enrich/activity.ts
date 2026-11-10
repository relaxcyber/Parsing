import type { ContentItem } from "@/core/contract";

export type ActivityStatus = "active" | "dormant" | "ghost" | "unknown";
export type Activity = { lastPostAt: Date | null; daysSincePost: number | null; status: ActivityStatus; medianViews: number | null; erViews: number | null };

const DAY = 86_400_000;

/**
 * Активність за глосарієм: свіжий — допис за останні 14 днів, засинає — 15–30, мертвий — понад 30.
 * Views ER — медіана переглядів останніх (до 10) відео, поділена на кількість підписників.
 */
export function activityOf(posts: Pick<ContentItem, "publishedAt" | "metrics">[], followers: number | null | undefined, now = new Date()): Activity {
  const dates = posts.map((p) => p.publishedAt?.getTime()).filter((t): t is number => typeof t === "number");
  const lastPostAt = dates.length ? new Date(Math.max(...dates)) : null;
  const daysSincePost = lastPostAt ? Math.max(0, Math.floor((now.getTime() - lastPostAt.getTime()) / DAY)) : null;
  const status: ActivityStatus = daysSincePost == null ? "unknown" : daysSincePost <= 14 ? "active" : daysSincePost <= 30 ? "dormant" : "ghost";

  const views = posts
    .filter((p) => typeof p.metrics.views === "number")
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, 10)
    .map((p) => p.metrics.views!)
    .sort((a, b) => a - b);
  const medianViews = views.length ? (views.length % 2 ? views[(views.length - 1) / 2] : Math.round((views[views.length / 2 - 1] + views[views.length / 2]) / 2)) : null;
  const erViews = medianViews != null && followers ? Math.round((medianViews / followers) * 1000) / 1000 : null;
  return { lastPostAt, daysSincePost, status, medianViews, erViews };
}

export const activityStatus = (lastPostAt: Date | null, now = new Date()): ActivityStatus =>
  activityOf(lastPostAt ? [{ publishedAt: lastPostAt, metrics: {} }] : [], null, now).status;
