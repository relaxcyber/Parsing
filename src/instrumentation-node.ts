/** Фонові задачі сервера (лише середовище Node.js): відновлення перерваних задач і виконавець черги. */
// Забута обробка помилки десь у фоні (обрив з’єднання з базою тощо) не повинна вбивати весь дашборд:
// записуємо її в журнал і працюємо далі.
process.on("unhandledRejection", (e) => console.error("Необроблена помилка у фоні:", e));

if (process.env.DATABASE_URL) {
  try {
    const [{ getDb }, { failInterruptedRuns }, search, scrape, outreach] = await Promise.all([
      import("@/db/client"), import("@/collect"), import("@/search/pipeline"), import("@/scrape/jobs"), import("@/outreach/engine"),
    ]);
    await failInterruptedRuns(getDb());
    await search.requeueInterrupted(getDb());
    await scrape.requeueInterruptedJobs(getDb());
    search.startSearchWorker(getDb, [scrape.runNextScrapeJob, outreach.runOutreach]);
  } catch (e) {
    console.error("Не вдалося запустити фонові задачі:", e);
  }
}

export {};
