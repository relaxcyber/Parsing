"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="primary" disabled={pending} aria-busy={pending}>
      {pending ? "Збираємо…" : "Зібрати"}
    </button>
  );
}
