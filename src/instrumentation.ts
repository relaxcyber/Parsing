/** Виконується один раз під час старту сервера. Код для Node.js — в окремому модулі, щоб не потрапив у збірку Edge. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
