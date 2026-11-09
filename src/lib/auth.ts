import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE = "dash_session";

function expectedToken(): string {
  const pass = process.env.DASHBOARD_PASSWORD;
  const master = process.env.MASTER_KEY;
  if (!pass || !master) throw new Error("Задайте DASHBOARD_PASSWORD і MASTER_KEY у .env");
  return createHmac("sha256", master).update(`dash:${pass}`).digest("hex");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function isAuthed(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE)?.value;
  return !!token && same(token, expectedToken());
}

/** Викликати на початку кожної захищеної сторінки та server action. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}

export async function login(password: string): Promise<boolean> {
  const pass = process.env.DASHBOARD_PASSWORD ?? "";
  const digest = (s: string) => createHmac("sha256", "cmp").update(s).digest("hex");
  if (!pass || !same(digest(password), digest(pass))) return false;
  (await cookies()).set(COOKIE, expectedToken(), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
    secure: process.env.COOKIE_SECURE === "1",
  });
  return true;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
