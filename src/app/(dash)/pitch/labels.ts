export const PITCH_STATUS = { draft: "чернетка", sent: "надіслано", replied: "відповіли", won: "замовлення", lost: "відмова" } as const;

export const FIT = {
  good: { label: "варто відгукнутися", cls: "risk-low" },
  maybe: { label: "подумайте", cls: "risk-medium" },
  skip: { label: "краще пропустити", cls: "risk-high" },
} as const;

export const JOB_TYPE = {
  find_creators: "знайти авторів", manage_outreach: "листування з авторами", be_a_creator: "шукають самого автора", other: "інше",
} as const;
