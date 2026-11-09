"use client";

export function ConfirmButton({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <button
      className="link danger"
      onClick={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
