"use client";

export default function DashError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <h2>Не вдалося відкрити сторінку</h2>
      <p className="sub">
        Найчастіше це означає, що база даних недоступна або в .env бракує налаштувань. Подробиці — у файлі data/server.log.
      </p>
      {error.digest && <p className="mono">Код помилки: {error.digest}</p>}
      <button className="primary" onClick={reset}>Спробувати ще раз</button>
    </div>
  );
}
