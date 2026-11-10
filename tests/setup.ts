import { vi } from "vitest";

// Тести не мають залежати від справжнього DNS: вигадані домени резолвляться в публічну адресу,
// а поштові записи є в усіх, крім доменів *.nomx.example.
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...real,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    resolveMx: async (domain: string) => {
      if (domain.endsWith("nomx.example")) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [{ exchange: `mx.${domain}`, priority: 10 }];
    },
  };
});
