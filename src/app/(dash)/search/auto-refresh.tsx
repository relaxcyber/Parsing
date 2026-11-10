"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Поки пошук виконується, сторінка сама оновлює дані кожні кілька секунд. */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
