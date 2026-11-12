/** Вбудовані шаблони пошуку: стартові налаштування під типові задачі. Значення — як у полях форми. */
export const BUILTIN_TEMPLATES: { name: string; data: Record<string, string> }[] = [
  {
    name: "UGC для реклами",
    data: {
      focus: "ugc", hashtags: "ugccreator, ugccontentcreator, ugcportfolio", keywords: "", stopWords: "giveaway, wholesale, agency",
      postsPerTag: "50", maxProfiles: "150", minFollowers: "1000", maxFollowers: "100000", auditLimit: "30", deepLimit: "10", commentsLimit: "0",
      "c.followers": "required", "c.activity": "required", activityDays: "30", "c.trust": "required", trustMaxRisk: "medium",
      "c.email": "preferred", "c.ads": "preferred", "c.formats": "preferred", formats: "talking_to_camera,product_demo",
      qualityMin: "45", qualityLead: "70", "w.quality": "2", "w.fit": "1", "w.readiness": "1", "w.trust": "1", "w.match": "1",
    },
  },
  {
    name: "Афіліати з аудиторією",
    data: {
      focus: "affiliate", hashtags: "amazonfinds, founditonamazon, ltkfinds", keywords: "", stopWords: "giveaway, wholesale",
      postsPerTag: "50", maxProfiles: "150", minFollowers: "5000", maxFollowers: "500000", auditLimit: "15", deepLimit: "5", commentsLimit: "10",
      "c.followers": "required", "c.activity": "required", activityDays: "21", "c.trust": "required", trustMaxRisk: "low",
      "c.er": "preferred", erMinPct: "1.5", "c.email": "preferred", "c.ads": "required",
      qualityMin: "35", qualityLead: "60", "w.trust": "2", "w.fit": "2", "w.quality": "1", "w.readiness": "1", "w.match": "1",
    },
  },
  {
    name: "Локальний бізнес",
    data: {
      focus: "ugc", hashtags: "", keywords: "", stopWords: "giveaway, wholesale, agency", postsPerTag: "40", maxProfiles: "80",
      minFollowers: "500", maxFollowers: "50000", auditLimit: "20", deepLimit: "5", commentsLimit: "5",
      "c.followers": "required", "c.country": "required", "c.language": "required", "c.activity": "required", activityDays: "30",
      "c.trust": "required", trustMaxRisk: "medium", "c.email": "preferred",
      qualityMin: "40", qualityLead: "65", "w.fit": "2", "w.trust": "1", "w.quality": "1", "w.readiness": "1", "w.match": "1",
    },
  },
];
