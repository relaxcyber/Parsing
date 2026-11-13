"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/search", label: "Пошук креаторів" },
  { href: "/creators", label: "Креатори" },
  { href: "/inbox", label: "Листування" },
  { href: "/clients", label: "Клієнти" },
  { href: "/pitch", label: "Відгуки на замовлення" },
  { href: "/orders", label: "Замовлення" },
  { href: "/report", label: "Звіт про роботу" },
  { href: "/quality", label: "Точність оцінок" },
  { href: "/scrape", label: "Парсинг сайтів" },
  { href: "/collect", label: "Разовий збір" },
  { href: "/keys", label: "Ключі та ліміти" },
  { href: "/help", label: "Довідка" },
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
