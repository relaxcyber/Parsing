"use client";

/** Друк сторінки або збереження в PDF (у вікні друку браузера: «Зберегти як PDF»). */
export function PrintButton({ label = "Друк / PDF" }: { label?: string }) {
  return <button type="button" onClick={() => window.print()}>{label}</button>;
}

/** Копіює текст у буфер обміну. */
export function CopyButton({ text, label = "Копіювати" }: { text: string; label?: string }) {
  return (
    <button type="button" className="chip" onClick={(e) => {
      void navigator.clipboard?.writeText(text);
      const b = e.currentTarget;
      b.textContent = "Скопійовано";
      setTimeout(() => (b.textContent = label), 1500);
    }}>{label}</button>
  );
}
