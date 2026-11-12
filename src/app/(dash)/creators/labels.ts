/** Статуси роботи з автором — для карток і списків. */
export const STATUS_LABELS = { new: "новий", contacted: "написали", replied: "відповів", in_work: "у роботі", posted: "опублікував", declined: "відмова" } as const;

/** Стан листування від імені клієнта. */
export const THREAD_LABELS = {
  draft: "готується перший лист", sent: "чекаємо відповіді", negotiating: "переговори", agreed: "узгоджено", to_ship: "відправити товар",
  shipped: "чекаємо допис", posted: "допис вийшов", declined: "відмова", no_reply: "без відповіді", closed: "закрито",
} as const;
