import { z } from "zod";

/**
 * Єдиний контракт даних: будь-який адаптер (веб, Reddit, Instagram, ...)
 * повертає масив ContentItem, і решта системи працює лише з ним.
 */

export const SOURCES = ["web", "reddit", "instagram", "tiktok", "x"] as const;
export const KINDS = ["post", "comment", "profile", "article", "video"] as const;
export const VIA = ["local", "scrapling", "scrapling-stealth", "reddit-api", "firecrawl", "apify"] as const;

const count = z.number().nonnegative().optional();

export const AuthorSchema = z.object({
  id: z.string().optional(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  url: z.url().optional(),
  avatarUrl: z.url().optional(),
  bio: z.string().optional(),
  followers: count,
  /** Посилання з профілю (link-in-bio) — джерело контактів. */
  links: z.array(z.url()).optional(),
  verified: z.boolean().optional(),
});

export const MediaSchema = z.object({
  type: z.enum(["image", "video", "audio"]),
  url: z.url(),
  thumbnailUrl: z.url().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
});

export const ContentItemSchema = z.object({
  /** Ідентифікатор у межах джерела (id поста, shortcode, URL статті). */
  id: z.string().min(1),
  source: z.enum(SOURCES),
  kind: z.enum(KINDS),
  url: z.url(),
  author: AuthorSchema.nullable().default(null),
  title: z.string().optional(),
  text: z.string().optional(),
  lang: z.string().optional(),
  tags: z.array(z.string()).default([]),
  media: z.array(MediaSchema).default([]),
  metrics: z
    .object({ likes: count, comments: count, shares: count, views: count, score: z.number().optional() })
    .default({}),
  /** Структура гілок: коментар посилається на батька та корінь треду. */
  thread: z
    .object({ parentId: z.string().optional(), rootId: z.string().optional(), depth: z.number().int().nonnegative().default(0) })
    .optional(),
  publishedAt: z.coerce.date().optional(),
  fetchedAt: z.coerce.date(),
  /** Яким способом каскаду отримано. */
  via: z.enum(VIA),
});

export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentItemInput = z.input<typeof ContentItemSchema>;
export type Author = z.infer<typeof AuthorSchema>;
export type Media = z.infer<typeof MediaSchema>;

export function parseContentItems(raw: unknown[]): ContentItem[] {
  return raw.map((r) => ContentItemSchema.parse(r));
}
