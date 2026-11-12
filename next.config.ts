import path from "node:path";
import type { NextConfig } from "next";

// Корінь проєкту задаємо явно: інакше Next.js шукає package-lock.json у батьківських теках
// (напр. випадковий C:\Users\<ім’я>\package-lock.json) і пише попередження в журнал.
const root = path.resolve(__dirname);

const config: NextConfig = {
  serverExternalPackages: ["postgres"],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
