import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function masterKey(): Buffer {
  const raw = process.env.MASTER_KEY;
  if (!raw || raw.length < 16) throw new Error("MASTER_KEY не задано або коротший за 16 символів");
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM; формат: v1.<iv>.<tag>.<ciphertext> у base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Невідомий формат зашифрованого ключа");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function secretTail(plain: string): string {
  return plain.length > 8 ? plain.slice(-4) : "";
}
