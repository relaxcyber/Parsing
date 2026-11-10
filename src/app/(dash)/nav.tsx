"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/keys", label: "Ключі та ліміти" },
  { href: "/search", label: "Пошук креаторів" },
  { href: "/scrape", label: "Парсинг сайтів" },
  { href: "/collect", label: "Разовий збір" },
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
