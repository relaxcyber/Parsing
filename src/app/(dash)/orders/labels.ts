import type { OrderStatus } from "@/db/schema";

export const ORDER_STATUS: Record<OrderStatus, { label: string; next: string; cls?: string }> = {
  clarifying: { label: "уточнюємо", next: "Надішліть клієнту питання й вставте його відповідь" },
  needs_you: { label: "потрібні ви", next: "Клієнт питає те, чого ІІ не знає: напишіть підказку", cls: "risk-high" },
  ready: { label: "завдання зрозуміле", next: "Надішліть підтвердження клієнту — пошук запуститься сам", cls: "risk-low" },
  searching: { label: "шукаємо", next: "Пошук іде — сторінка оновиться сама" },
  results: { label: "результат готовий", next: "Напишіть повідомлення з результатом і прикладіть CSV", cls: "risk-low" },
  delivered: { label: "здано", next: "Попросіть у клієнта відгук і запропонуйте наступний етап" },
  closed: { label: "закрито", next: "" },
};
