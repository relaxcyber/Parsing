/** Виконується один раз під час старту сервера. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  try {
    const [{ getDb }, { failInterruptedRuns }] = await Promise.all([import("@/db/client"), import("@/collect")]);
    await failInterruptedRuns(getDb());
  } catch (e) {
    console.error("Не вдалося зняти блокування перерваних зборів:", e);
  }
}
