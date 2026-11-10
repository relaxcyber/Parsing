export const STATUS = {
  queued: { label: "У черзі", color: "var(--ink-3)" },
  running: { label: "Виконується", color: "var(--warning)" },
  done: { label: "Готово", color: "var(--good)" },
  failed: { label: "Помилка", color: "var(--critical)" },
  cancelled: { label: "Скасовано", color: "var(--ink-3)" },
} as const;

export const LANGS: Record<string, string> = {
  en: "англійська", uk: "українська", ru: "російська", pl: "польська", de: "німецька", es: "іспанська",
};
