/** Виконується один раз під час старту сервера. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  try {
    const [{ getDb }, { failInterruptedRuns }, search] = await Promise.all([
      import("@/db/client"), import("@/collect"), import("@/search/pipeline"),
    ]);
    await failInterruptedRuns(getDb());
    await search.requeueInterrupted(getDb());
    search.startSearchWorker(getDb);
  } catch (e) {
    console.error("Не вдалося запустити фонові задачі:", e);
  }
}
