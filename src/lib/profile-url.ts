/** Посилання на профіль автора на його платформі. */
export function profileUrl(platform: string, username: string): string {
  return platform === "tiktok" ? `https://www.tiktok.com/@${username}` : `https://www.instagram.com/${username}/`;
}

/** Коротко для показу: «instagram.com/name» чи «tiktok.com/@name». */
export const profileLabel = (platform: string, username: string) => (platform === "tiktok" ? `tiktok.com/@${username}` : `instagram.com/${username}`);
