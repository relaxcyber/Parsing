"use client";

export function ConfirmButton({ question, label, children }: { question: string; label?: string; children: React.ReactNode }) {
  return (
    <button
      className="link danger"
      aria-label={label}
      onClick={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
