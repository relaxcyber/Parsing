"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/keys", label: "Ключі та ліміти" },
  { href: "/collect", label: "Збір даних" },
];

export function Nav() {
  const path = usePathname();
  return (
    <>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? "on" : undefined} aria-current={path.startsWith(l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </>
  );
}
