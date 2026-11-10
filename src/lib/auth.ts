import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { sessions } from "@/db/schema";

const COOKIE = "dash_session";
const SESSION_MS = 30 * 24 * 3600_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return false;
  const [row] = await getDb().select().from(sessions).where(eq(sessions.tokenHash, hash(token)));
  return !!row && row.expiresAt > new Date();
}

/** Викликати на початку кожної захищеної сторінки та server action. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}

/**
 * Захист від перебору: після 5 невдалих спроб — пауза, що подвоюється (30 с … 1 год).
 * Лічильник спільний для всіх, бо користувач один; живе в пам’яті процесу.
 */
const guard = ((globalThis as any).__loginGuard ??= { failures: 0, lockedUntil: 0 }) as { failures: number; lockedUntil: number };
const FREE_ATTEMPTS = 5;

export function loginLockSeconds(now = Date.now()): number {
  return Math.max(0, Math.ceil((guard.lockedUntil - now) / 1000));
}

export type LoginResult = { ok: true } | { ok: false; reason: "wrong" | "locked"; waitSec: number };

export async function login(password: string): Promise<LoginResult> {
  const expected = process.env.DASHBOARD_PASSWORD ?? "";
  if (!expected) throw new Error("Задайте DASHBOARD_PASSWORD у .env");
  const locked = loginLockSeconds();
  if (locked > 0) return { ok: false, reason: "locked", waitSec: locked };

  const digest = (s: string) => createHmac("sha256", "cmp").update(s).digest();
  if (!timingSafeEqual(digest(password), digest(expected))) {
    guard.failures++;
    if (guard.failures >= FREE_ATTEMPTS) {
      const waitSec = Math.min(3600, 30 * 2 ** (guard.failures - FREE_ATTEMPTS));
      guard.lockedUntil = Date.now() + waitSec * 1000;
      return { ok: false, reason: "locked", waitSec };
    }
    return { ok: false, reason: "wrong", waitSec: 0 };
  }
  guard.failures = 0;
  guard.lockedUntil = 0;

  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({ tokenHash: hash(token), expiresAt: new Date(Date.now() + SESSION_MS) });
  // Через HTTPS (напр. зворотний проксі) cookie позначається secure автоматично.
  const proto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MS / 1000,
    secure: proto === "https" || process.env.COOKIE_SECURE === "1",
  });
  return { ok: true };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, hash(token)));
  jar.delete(COOKIE);
}
