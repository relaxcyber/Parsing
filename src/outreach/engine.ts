import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { profilePosts, type PostFacts } from "@/analysis/posts";
import type { Db } from "@/db/client";
import {
  clients, contentItems, creatorContacts, creators, mailboxes, outreachMessages, outreachThreads, searchCandidates, searches, suppressions,
  type ClientPolicy, type Mailbox, type OutreachMessage, type OutreachStatus, type OutreachThread, type PostCheck, type ThreadStatus,
} from "@/db/schema";
import { collect } from "@/collect";
import { detectLanguage } from "@/enrich/geo";
import { LlmUnavailableError } from "@/llm/client";
import { emailKey, suppressedSet, usernameKey } from "@/search/suppress";
import { firstName, generateDraft, SENDER } from "./draft";
import { newMessageId, normEmail, stripQuoted, transportFor, type InMail } from "./mail";
import {
  analyzeReply, answerFromPolicy, decide, NEGOTIATE_VERSION, replyFacts, writeReply,
  type Decision, type Plan, type ReplyAnalysis,
} from "./negotiate";
import { offerText, policyOf } from "./policy";

/**
 * Листування від імені клієнта: перший лист, нагадування, розбір відповідей, торг у межах правил,
 * узгодження, відправка товару, перевірка публікації. Людина потрібна лише там, де правила мовчать.
 * Усе виконується у фоновому виконавці (startSearchWorker) маленькими кроками.
 */

const DAY = 86_400_000;
/** Скільки днів у середньому їде товар: строк публікації рахуємо від відправки + доставка. */
export const DELIVERY_DAYS = 5;
const POLL_EVERY_MS = 2 * 60_000;
/** Пауза між листами з однієї скриньки: пачка однакових листів підряд — ознака спаму для поштовиків. */
const SEND_GAP_MS = 90_000;
const LANGS = new Set(["en", "uk", "ru", "pl", "de", "es"]);

const g = globalThis as unknown as { __outreach?: { lastPoll: Map<number, number>; lastSend: Map<number, number>; llmPausedUntil: number } };
const state = (g.__outreach ??= { lastPoll: new Map(), lastSend: new Map(), llmPausedUntil: 0 });

/** Для тестів: забути паузи між опитуваннями й листами. */
export function resetOutreachTimers(): void {
  state.lastPoll.clear();
  state.lastSend.clear();
  state.llmPausedUntil = 0;
}

/** Статус автора в загальному списку — за станом листування. */
const CREATOR_STATUS: Partial<Record<ThreadStatus, OutreachStatus>> = {
  sent: "contacted", no_reply: "contacted", negotiating: "replied", agreed: "in_work", to_ship: "in_work", shipped: "in_work",
  posted: "posted", declined: "declined",
};

async function syncCreatorStatus(db: Db, creatorId: number, status: ThreadStatus) {
  const s = CREATOR_STATUS[status];
  if (s) await db.update(creators).set({ outreachStatus: s, outreachAt: new Date() }).where(eq(creators.id, creatorId));
}

async function updateThread(db: Db, t: OutreachThread, patch: Partial<typeof outreachThreads.$inferInsert>) {
  await db.update(outreachThreads).set({ ...patch, updatedAt: new Date() }).where(eq(outreachThreads.id, t.id));
  if (patch.status && patch.status !== t.status) await syncCreatorStatus(db, t.creatorId, patch.status);
}

async function loadThread(db: Db, id: number) {
  const [t] = await db.select().from(outreachThreads).where(eq(outreachThreads.id, id));
  if (!t) throw new Error("Листування не знайдено");
  const [client] = await db.select().from(clients).where(eq(clients.id, t.clientId));
  const [creator] = await db.select().from(creators).where(eq(creators.id, t.creatorId));
  return { t, client, policy: policyOf(client?.policy), creator };
}

/* ---------- початок листування ---------- */

/** Найкраща адреса автора: особиста з найвищою впевненістю, інакше перша з профілю. */
async function bestEmail(db: Db, creatorId: number, fallback: string[]): Promise<string | null> {
  const rows = await db.select().from(creatorContacts).where(eq(creatorContacts.creatorId, creatorId)).orderBy(desc(creatorContacts.confidence));
  const ok = rows.filter((r) => r.status !== "invalid" && r.status !== "disposable");
  return ok.find((r) => r.status === "personal")?.email ?? ok[0]?.email ?? fallback[0] ?? null;
}

export type StartResult = { id: number | null; created: boolean; error?: string };

export async function startThread(db: Db, input: { creatorId: number; clientId: number; searchId?: number | null; toEmail?: string | null }): Promise<StartResult> {
  const [client] = await db.select().from(clients).where(eq(clients.id, input.clientId));
  if (!client) return { id: null, created: false, error: "Клієнта не знайдено" };
  if (!client.mailboxId) return { id: null, created: false, error: "У клієнта не вибрано поштову скриньку" };
  const [c] = await db.select().from(creators).where(eq(creators.id, input.creatorId));
  if (!c) return { id: null, created: false, error: "Автора не знайдено" };
  const email = input.toEmail?.trim() || (await bestEmail(db, c.id, c.emails));
  if (!email) return { id: null, created: false, error: "У автора немає email" };
  const blocked = await suppressedSet(db, [usernameKey(c.platform, c.username), emailKey(email)]);
  if (blocked.size) return { id: null, created: false, error: "Автор у списку виключень" };
  const [s] = input.searchId ? await db.select().from(searches).where(eq(searches.id, input.searchId)) : [];
  const [row] = await db.insert(outreachThreads).values({
    creatorId: c.id, clientId: client.id, searchId: s?.id ?? null, mailboxId: client.mailboxId, toEmail: normEmail(email),
    subject: "", language: s?.outreachLanguage ?? (c.language && LANGS.has(c.language) ? c.language : "en"), status: "draft", nextActionAt: new Date(),
  }).onConflictDoNothing().returning({ id: outreachThreads.id });
  if (row) return { id: row.id, created: true };
  const [existing] = await db.select({ id: outreachThreads.id }).from(outreachThreads)
    .where(and(eq(outreachThreads.creatorId, c.id), eq(outreachThreads.clientId, client.id)));
  return { id: existing?.id ?? null, created: false };
}

/** Листування з усіма готовими лідами пошуку, яким ще не писали. Перші листи пише фоновий виконавець. */
export async function startThreadsForSearch(db: Db, searchId: number): Promise<{ created: number; skipped: number; error?: string }> {
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!s?.clientId) return { created: 0, skipped: 0, error: "У пошуку не вибрано клієнта" };
  const leads = await db.select({ id: creators.id, status: creators.outreachStatus }).from(searchCandidates)
    .innerJoin(creators, eq(creators.id, searchCandidates.creatorId))
    .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.lead, true)));
  let created = 0;
  let skipped = 0;
  for (const l of leads) {
    if (l.status === "declined") {
      skipped++;
      continue;
    }
    const r = await startThread(db, { creatorId: l.id, clientId: s.clientId, searchId });
    if (r.created) created++;
    else skipped++;
  }
  return { created, skipped };
}

/* ---------- перший лист і нагадування ---------- */

async function generateFirst(db: Db, t: OutreachThread): Promise<void> {
  const { policy, client } = await loadThread(db, t.id);
  const [s] = t.searchId ? await db.select().from(searches).where(eq(searches.id, t.searchId)) : [];
  const d = await generateDraft(db, t.creatorId, t.searchId, {
    brand: { brandName: policy.brandName || client?.name || null, offer: offerText(policy), brief: s?.brief ?? (policy.product || null) },
    language: t.language,
  });
  const auto = policy.mode === "auto" && d.issues.length === 0;
  await db.insert(outreachMessages).values({
    threadId: t.id, direction: "out", kind: "first", status: auto ? "queued" : "draft", subject: d.data.subject_a, body: d.data.email,
    ai: { draftId: d.id, followups: [d.data.followup_1, d.data.followup_2], subjectB: d.data.subject_b }, issues: d.issues,
  });
  await updateThread(db, t, {
    subject: d.data.subject_a, nextActionAt: null,
    needsHuman: d.issues.length && policy.mode === "auto" ? `Перший лист не пройшов перевірку: ${d.issues.join("; ")}` : null,
  });
}

async function hasPending(db: Db, threadId: number): Promise<boolean> {
  const [p] = await db.select({ id: outreachMessages.id }).from(outreachMessages)
    .where(and(eq(outreachMessages.threadId, threadId), eq(outreachMessages.direction, "out"), inArray(outreachMessages.status, ["draft", "queued"]))).limit(1);
  return !!p;
}

async function queueFollowup(db: Db, t: OutreachThread): Promise<void> {
  const { policy } = await loadThread(db, t.id);
  if (await hasPending(db, t.id)) return;
  if (t.followups >= 2) {
    await updateThread(db, t, { status: "no_reply", nextActionAt: null });
    return;
  }
  const [first] = await db.select().from(outreachMessages)
    .where(and(eq(outreachMessages.threadId, t.id), eq(outreachMessages.kind, "first"))).limit(1);
  const text = (first?.ai as { followups?: string[] } | null)?.followups?.[t.followups];
  if (!text) {
    await updateThread(db, t, { status: "no_reply", nextActionAt: null });
    return;
  }
  await db.insert(outreachMessages).values({
    threadId: t.id, direction: "out", kind: "followup", status: policy.mode === "auto" ? "queued" : "draft", subject: t.subject, body: text,
  });
  await updateThread(db, t, { followups: t.followups + 1, nextActionAt: null });
}

/* ---------- надсилання ---------- */

async function sentToday(db: Db, mailboxId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(outreachMessages)
    .where(and(eq(outreachMessages.mailboxId, mailboxId), eq(outreachMessages.status, "sent"), gte(outreachMessages.sentAt, new Date(Date.now() - DAY))));
  return r?.n ?? 0;
}

export function signature(body: string, policy: ClientPolicy, mb: Mailbox | undefined): string {
  return body.replaceAll(SENDER, policy.senderName || mb?.fromName || "").trimEnd();
}

async function sendMessage(db: Db, m: OutreachMessage, t: OutreachThread, mb: Mailbox, policy: ClientPolicy): Promise<void> {
  if (m.kind === "first") {
    const [c] = await db.select({ platform: creators.platform, username: creators.username }).from(creators).where(eq(creators.id, t.creatorId));
    const blocked = await suppressedSet(db, [emailKey(t.toEmail), ...(c ? [usernameKey(c.platform, c.username)] : [])]);
    if (blocked.size) {
      await db.update(outreachMessages).set({ status: "discarded", error: "автор у списку виключень" }).where(eq(outreachMessages.id, m.id));
      await updateThread(db, t, { status: "closed" });
      return;
    }
  }
  const history = await db.select({ messageId: outreachMessages.messageId, direction: outreachMessages.direction }).from(outreachMessages)
    .where(and(eq(outreachMessages.threadId, t.id), inArray(outreachMessages.status, ["sent", "received"]))).orderBy(asc(outreachMessages.createdAt));
  const refs = history.map((h) => h.messageId).filter((x): x is string => !!x);
  const lastIn = [...history].reverse().find((h) => h.direction === "in")?.messageId ?? refs.at(-1) ?? null;
  const subject = m.kind === "first" ? m.subject : /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
  const body = signature(m.body, policy, mb);
  const messageId = newMessageId(mb.email);
  try {
    await transportFor(mb).send({ from: mb.email, fromName: mb.fromName, to: t.toEmail, subject, text: body, messageId, inReplyTo: m.kind === "first" ? null : lastIn, references: m.kind === "first" ? [] : refs });
  } catch (e) {
    const err = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.update(outreachMessages).set({ status: "failed", error: err, mailboxId: mb.id }).where(eq(outreachMessages.id, m.id));
    await updateThread(db, t, { needsHuman: `Не вдалося надіслати лист: ${err}` });
    return;
  }
  const now = new Date();
  await db.update(outreachMessages).set({ status: "sent", sentAt: now, messageId, mailboxId: mb.id, subject, body, fromEmail: mb.email, toEmail: t.toEmail })
    .where(eq(outreachMessages.id, m.id));
  const waiting = m.kind === "first" || m.kind === "followup";
  await updateThread(db, t, {
    lastOutboundAt: now,
    status: t.status === "draft" ? "sent" : t.status,
    // Нагадування — лише поки автор мовчить після першого листа.
    nextActionAt: waiting && !t.lastInboundAt ? new Date(now.getTime() + policy.followupDays * DAY) : t.nextActionAt,
  });
}

async function sendNext(db: Db): Promise<boolean> {
  const queued = await db.select({ m: outreachMessages, t: outreachThreads }).from(outreachMessages)
    .innerJoin(outreachThreads, eq(outreachThreads.id, outreachMessages.threadId))
    .where(and(eq(outreachMessages.status, "queued"), eq(outreachMessages.direction, "out")))
    .orderBy(asc(outreachMessages.createdAt)).limit(50);
  for (const { m, t } of queued) {
    if (!t.mailboxId) continue;
    const last = state.lastSend.get(t.mailboxId) ?? 0;
    if (Date.now() - last < SEND_GAP_MS) continue;
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId));
    if (!mb || (await sentToday(db, mb.id)) >= mb.dailyLimit) continue;
    const { policy } = await loadThread(db, t.id);
    state.lastSend.set(mb.id, Date.now());
    await sendMessage(db, m, t, mb, policy);
    return true;
  }
  return false;
}

/* ---------- вхідні листи ---------- */

const ANGLE_ID = /<[^<>\s]+@[^<>\s]+>/g;

/** Знаходить листування, до якого належить вхідний лист: за заголовками відповіді, а для недоставки — за нашим Message-ID у тексті. */
async function threadFor(db: Db, mb: Mailbox, mail: InMail): Promise<number | null> {
  const ids = [mail.inReplyTo, ...mail.references, ...(mail.bounce ? mail.text.match(ANGLE_ID) ?? [] : [])].filter((x): x is string => !!x);
  if (ids.length) {
    const [hit] = await db.select({ threadId: outreachMessages.threadId }).from(outreachMessages)
      .where(and(inArray(outreachMessages.messageId, ids), eq(outreachMessages.direction, "out"))).limit(1);
    if (hit) return hit.threadId;
  }
  if (mail.bounce) return null;
  const [byAddr] = await db.select({ id: outreachThreads.id }).from(outreachThreads)
    .where(and(eq(outreachThreads.toEmail, normEmail(mail.from)), eq(outreachThreads.mailboxId, mb.id)))
    .orderBy(desc(outreachThreads.updatedAt)).limit(1);
  return byAddr?.id ?? null;
}

export async function ingestMail(db: Db, mb: Mailbox, mail: InMail): Promise<number | null> {
  const messageId = mail.messageId ?? `<uid-${mb.id}-${mail.uid}@parsing.local>`;
  const [dup] = await db.select({ id: outreachMessages.id }).from(outreachMessages).where(eq(outreachMessages.messageId, messageId));
  if (dup) return null;
  const threadId = await threadFor(db, mb, mail);
  if (threadId == null) return null; // лист не з наших розмов
  const [t] = await db.select().from(outreachThreads).where(eq(outreachThreads.id, threadId));
  const body = (mail.bounce ? mail.text : stripQuoted(mail.text) || mail.text).slice(0, 8000);
  const [row] = await db.insert(outreachMessages).values({
    threadId, mailboxId: mb.id, direction: "in", kind: "inbound", status: "received", subject: mail.subject.slice(0, 300), body,
    messageId, inReplyTo: mail.inReplyTo, fromEmail: normEmail(mail.from), toEmail: mb.email, receivedAt: mail.date,
    ai: mail.bounce ? { processed: true, bounce: true } : { auto: mail.auto },
  }).onConflictDoNothing().returning({ id: outreachMessages.id });
  if (!row) return null;
  await updateThread(db, t, mail.bounce
    ? { needsHuman: "Лист не доставлено: адреса не існує або скринька переповнена. Знайдіть іншу адресу чи закрийте листування.", nextActionAt: null }
    : { lastInboundAt: mail.date, nextActionAt: null });
  return row.id;
}

async function pollMailbox(db: Db, mb: Mailbox): Promise<number> {
  try {
    const r = await transportFor(mb).fetchNew(mb.lastUid, mb.uidValidity);
    let n = 0;
    for (const mail of r.mails) if (await ingestMail(db, mb, mail)) n++;
    await db.update(mailboxes).set({ lastUid: r.lastUid, uidValidity: r.uidValidity, lastPolledAt: new Date(), lastError: null }).where(eq(mailboxes.id, mb.id));
    return n;
  } catch (e) {
    await db.update(mailboxes).set({ lastPolledAt: new Date(), lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).where(eq(mailboxes.id, mb.id));
    return 0;
  }
}

/* ---------- розбір відповіді й рішення ---------- */

function replyLanguage(text: string, fallback: string): string {
  const d = detectLanguage(text);
  return d.language && d.confidence >= 0.5 && LANGS.has(d.language) ? d.language : fallback;
}

/** Розбирає вхідний лист і діє за рішенням. Повторний виклик (після відповіді людини) переоцінює той самий лист. */
export async function handleInbound(db: Db, messageId: number): Promise<Decision> {
  const [msg] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, messageId));
  if (!msg) throw new Error("Лист не знайдено");
  const { t, policy, creator } = await loadThread(db, msg.threadId);
  const [lastOut] = await db.select().from(outreachMessages)
    .where(and(eq(outreachMessages.threadId, t.id), eq(outreachMessages.direction, "out"), eq(outreachMessages.status, "sent")))
    .orderBy(desc(outreachMessages.sentAt)).limit(1);

  let analysis: ReplyAnalysis | null = null;
  let decision: Decision;
  let model: string | null = null;
  if ((msg.ai as { auto?: boolean } | null)?.auto) {
    decision = { action: "wait", days: 5, why: "автовідповідь: автор недоступний" };
  } else {
    const r = await analyzeReply(db, msg.body, lastOut?.body ?? null);
    analysis = r.analysis;
    model = r.model;
    const qs = analysis.questions.map((q) => q.question);
    const { answered, unknown } = await answerFromPolicy(db, policy, qs);
    decision = decide(policy, t, analysis, answered, unknown);
  }
  const language = replyLanguage(msg.body, t.language);
  await applyDecision(db, t, msg, decision, policy, creator ? { name: firstName(creator.displayName), handle: `@${creator.username}` } : { name: null, handle: "" }, language);
  await db.update(outreachMessages).set({ ai: { processed: true, analysis, decision, model, version: NEGOTIATE_VERSION } }).where(eq(outreachMessages.id, msg.id));
  return decision;
}

async function queueReply(db: Db, t: OutreachThread, p: Plan, policy: ClientPolicy, who: { name: string | null; handle: string }, inbound: string, language: string, why: string): Promise<string[]> {
  const facts = replyFacts(policy, who, p);
  const r = await writeReply(db, facts, inbound, language);
  const auto = policy.mode === "auto" && r.issues.length === 0;
  await db.insert(outreachMessages).values({
    threadId: t.id, direction: "out", kind: "reply", status: auto ? "queued" : "draft", subject: t.subject, body: r.body,
    ai: { plan: p, why, model: r.model, version: NEGOTIATE_VERSION }, issues: r.issues,
  });
  return r.issues;
}

async function applyDecision(db: Db, t: OutreachThread, msg: OutreachMessage, d: Decision, policy: ClientPolicy, who: { name: string | null; handle: string }, language: string) {
  // Старі неочищені чернетки після нової відповіді автора вже неактуальні.
  await db.update(outreachMessages).set({ status: "discarded" })
    .where(and(eq(outreachMessages.threadId, t.id), eq(outreachMessages.direction, "out"), inArray(outreachMessages.status, ["draft", "queued"])));
  if (d.action === "close") {
    if (d.unsubscribe) await db.insert(suppressions).values({ key: emailKey(t.toEmail), reason: "автор попросив більше не писати" }).onConflictDoNothing();
    await updateThread(db, t, { status: "declined", needsHuman: null, openQuestions: [], nextActionAt: null });
    return;
  }
  if (d.action === "wait") {
    await updateThread(db, t, { nextActionAt: new Date(Date.now() + d.days * DAY) });
    return;
  }
  if (d.action === "escalate") {
    await updateThread(db, t, {
      status: t.status === "sent" || t.status === "draft" ? "negotiating" : t.status,
      needsHuman: d.reason, openQuestions: d.questions ?? [], askedFeeUsd: d.askedFeeUsd ?? t.askedFeeUsd,
    });
    return;
  }
  const issues = await queueReply(db, t, d.plan, policy, who, msg.body, language, d.why);
  const agreed = d.status === "agreed" || d.status === "to_ship";
  await updateThread(db, t, {
    status: d.status, language,
    terms: d.terms ?? t.terms, offeredFeeUsd: d.offeredFeeUsd !== undefined ? d.offeredFeeUsd : t.offeredFeeUsd,
    askedFeeUsd: d.askedFeeUsd !== undefined ? d.askedFeeUsd : t.askedFeeUsd,
    rounds: d.roundsInc ? t.rounds + 1 : t.rounds,
    shipping: d.shipping ?? t.shipping,
    agreedAt: agreed && !t.agreedAt ? new Date() : t.agreedAt,
    needsHuman: issues.length ? `Відповідь не пройшла перевірку: ${issues.join("; ")}` : null,
    openQuestions: [],
  });
}

/* ---------- перевірка публікації ---------- */

/** Чи допис виконує умову: відмічено @бренд (у тексті, відмітках чи як співавтора) або є #хештег / слово. */
export function matchPost(p: PostFacts, mustTag: string[]): string[] {
  const caption = p.caption.toLowerCase();
  const handles = new Set([...p.mentions, ...p.tagged, ...p.coauthors]);
  return mustTag.filter((raw) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return false;
    if (tag.startsWith("@")) return handles.has(tag.slice(1)) || new RegExp(`(^|[^\\w.])${tag.replace(/[.]/g, "\\.")}(?![\\w])`).test(caption);
    if (tag.startsWith("#")) return p.hashtags.includes(tag.slice(1)) || caption.includes(tag);
    return caption.includes(tag);
  });
}

const DISCLOSURE = /#(ad|ads|advert|advertisement|sponsored|gifted|partner|partnership|collab|anzeige|werbung|reklama|реклама)\b|paid partnership|реклама/i;
export const hasDisclosure = (p: PostFacts) => p.paid === true || DISCLOSURE.test(p.caption);

export async function checkPost(db: Db, threadId: number): Promise<PostCheck> {
  const { t, policy, creator } = await loadThread(db, threadId);
  if (!creator) throw new Error("Автора не знайдено");
  const now = new Date();
  if (policy.mustTag.length === 0) {
    await updateThread(db, t, { needsHuman: "Не задано @бренд чи #хештег у правилах клієнта — допис не перевірити автоматично", nextActionAt: null });
    return { checkedAt: now.toISOString(), found: false, note: "немає позначок для перевірки" };
  }
  await collect(db, { type: "instagram-profile", username: creator.username }, { fresh: true });
  const [profile] = await db.select({ raw: contentItems.raw }).from(contentItems)
    .where(and(eq(contentItems.source, creator.platform), eq(contentItems.externalId, `profile:${creator.username}`)));
  const since = t.agreedAt ?? t.shippedAt ?? t.createdAt;
  const posts = profilePosts(profile?.raw).filter((p) => !p.publishedAt || p.publishedAt >= since);
  const hit = posts.map((p) => ({ p, tags: matchPost(p, policy.mustTag) })).find((x) => x.tags.length > 0);
  const prev = t.postCheck;
  if (hit) {
    const disclosure = hasDisclosure(hit.p);
    const check: PostCheck = { checkedAt: now.toISOString(), found: true, url: hit.p.url, disclosure, tags: hit.tags };
    await updateThread(db, t, {
      status: "posted", postUrl: hit.p.url, postedAt: hit.p.publishedAt ?? now, postCheck: check, nextActionAt: null,
      needsHuman: disclosure ? null : "Допис вийшов без позначки реклами (#ad чи «Платне партнерство») — попросіть автора додати її",
    });
    return check;
  }
  const due = t.postDueAt ?? new Date(since.getTime() + (policy.deadlineDays + DELIVERY_DAYS) * DAY);
  const check: PostCheck = { checkedAt: now.toISOString(), found: false, note: `дописів після ${since.toISOString().slice(0, 10)} з ${policy.mustTag.join(", ")} немає` };
  if (now.getTime() > due.getTime() + 7 * DAY) {
    await updateThread(db, t, { postCheck: check, nextActionAt: null, needsHuman: "Допис не вийшов через тиждень після строку — нагадування вже було, потрібне ваше рішення" });
  } else {
    // Після строку — одне нагадування від ІІ, далі перевіряємо щодня ще тиждень.
    const remind = now > due && !prev?.note?.includes("нагадано");
    if (remind && !(await hasPending(db, t.id))) {
      await queueReply(db, t, { kind: "remind_post", feeUsd: null, barter: false, askRate: false, askAddress: false, answers: [] }, policy, { name: firstName(creator.displayName), handle: `@${creator.username}` }, "", t.language, "строк публікації минув");
      check.note += "; нагадано";
    } else if (prev?.note?.includes("нагадано")) check.note += "; нагадано";
    await updateThread(db, t, { postCheck: check, nextActionAt: new Date(now.getTime() + DAY) });
  }
  return check;
}

/* ---------- дії людини ---------- */

export async function approveMessage(db: Db, id: number, edit: { subject?: string; body?: string } = {}): Promise<void> {
  const [m] = await db.select().from(outreachMessages).where(eq(outreachMessages.id, id));
  if (!m || (m.status !== "draft" && m.status !== "failed")) throw new Error("Чернетку не знайдено або її вже надіслано");
  const body = edit.body?.trim() || m.body;
  const subject = edit.subject?.trim() || m.subject;
  await db.update(outreachMessages).set({ status: "queued", body, subject, error: null }).where(eq(outreachMessages.id, id));
  const { t } = await loadThread(db, m.threadId);
  await updateThread(db, t, { subject: m.kind === "first" ? subject : t.subject, needsHuman: t.needsHuman?.startsWith("Відповідь не пройшла") || t.needsHuman?.startsWith("Перший лист") ? null : t.needsHuman });
}

export async function discardMessage(db: Db, id: number): Promise<void> {
  await db.update(outreachMessages).set({ status: "discarded" }).where(and(eq(outreachMessages.id, id), inArray(outreachMessages.status, ["draft", "queued", "failed"])));
}

async function lastInbound(db: Db, threadId: number) {
  const [m] = await db.select().from(outreachMessages)
    .where(and(eq(outreachMessages.threadId, threadId), eq(outreachMessages.direction, "in"))).orderBy(desc(outreachMessages.createdAt)).limit(1);
  return m;
}

/**
 * Людина відповіла на питання, якого не було в правилах: відповідь стає новим пунктом правил клієнта,
 * і ІІ одразу відповідає автору. Наступного разу таке саме питання він закриє сам.
 */
export async function answerQuestions(db: Db, threadId: number, qa: { q: string; a: string }[]): Promise<Decision | null> {
  const { t, client, policy } = await loadThread(db, threadId);
  const add = qa.filter((x) => x.q.trim() && x.a.trim()).map((x) => ({ q: x.q.trim(), a: x.a.trim(), addedAt: new Date().toISOString() }));
  if (client && add.length) await db.update(clients).set({ policy: { ...policy, faq: [...policy.faq, ...add] } }).where(eq(clients.id, client.id));
  await updateThread(db, t, { needsHuman: null, openQuestions: [] });
  const m = await lastInbound(db, threadId);
  return m ? handleInbound(db, m.id) : null;
}

/** Людина дозволила ставку понад стелю (чи без стелі): ІІ підтверджує угоду. */
export async function allowFee(db: Db, threadId: number, feeUsd: number): Promise<void> {
  const { t, policy, creator } = await loadThread(db, threadId);
  const product = policy.offerType !== "paid";
  const m = await lastInbound(db, threadId);
  const plan: Plan = { kind: "accept", feeUsd, barter: product, askRate: false, askAddress: product && !t.shipping, answers: [] };
  const issues = await queueReply(db, t, plan, policy, { name: firstName(creator?.displayName ?? null), handle: `@${creator?.username ?? ""}` }, m?.body ?? "", t.language, "ставку дозволила людина");
  await updateThread(db, t, {
    status: t.shipping ? "to_ship" : "agreed", agreedAt: t.agreedAt ?? new Date(), offeredFeeUsd: feeUsd,
    terms: { feeUsd, barter: product, deliverables: policy.deliverables, deadlineDays: policy.deadlineDays },
    needsHuman: issues.length ? `Відповідь не пройшла перевірку: ${issues.join("; ")}` : null,
  });
}

/** Перечитати останню відповідь автора (наприклад, після зміни правил клієнта). */
export async function reprocess(db: Db, threadId: number): Promise<Decision | null> {
  const { t } = await loadThread(db, threadId);
  await updateThread(db, t, { needsHuman: null, openQuestions: [] });
  const m = await lastInbound(db, threadId);
  if (m) return handleInbound(db, m.id);
  await db.update(outreachMessages).set({ status: "discarded" })
    .where(and(eq(outreachMessages.threadId, threadId), eq(outreachMessages.kind, "first"), eq(outreachMessages.status, "draft")));
  await updateThread(db, t, { status: "draft", nextActionAt: new Date() });
  return null;
}

export async function manualReply(db: Db, threadId: number, body: string): Promise<void> {
  const { t } = await loadThread(db, threadId);
  if (!body.trim()) throw new Error("Порожній лист");
  await db.insert(outreachMessages).values({ threadId, direction: "out", kind: t.status === "draft" ? "first" : "manual", status: "queued", subject: t.subject || "Collaboration", body: body.trim() });
  await updateThread(db, t, { needsHuman: null, openQuestions: [] });
}

export async function markShipped(db: Db, threadId: number): Promise<void> {
  const { t, policy } = await loadThread(db, threadId);
  const now = Date.now();
  await updateThread(db, t, {
    status: "shipped", shippedAt: new Date(now), needsHuman: null,
    postDueAt: new Date(now + (DELIVERY_DAYS + policy.deadlineDays) * DAY),
    nextActionAt: new Date(now + 3 * DAY),
  });
}

export async function markPosted(db: Db, threadId: number, url: string): Promise<void> {
  const { t } = await loadThread(db, threadId);
  await updateThread(db, t, { status: "posted", postUrl: url.trim(), postedAt: new Date(), nextActionAt: null, needsHuman: null,
    postCheck: { checkedAt: new Date().toISOString(), found: true, url: url.trim(), note: "позначено вручну" } });
}

export async function setThreadStatus(db: Db, threadId: number, status: ThreadStatus): Promise<void> {
  const { t } = await loadThread(db, threadId);
  await updateThread(db, t, { status, needsHuman: null, nextActionAt: null });
  if (status === "declined" || status === "closed") await discardPending(db, threadId);
}

async function discardPending(db: Db, threadId: number) {
  await db.update(outreachMessages).set({ status: "discarded" })
    .where(and(eq(outreachMessages.threadId, threadId), eq(outreachMessages.direction, "out"), inArray(outreachMessages.status, ["draft", "queued"])));
}

export async function resolveHuman(db: Db, threadId: number): Promise<void> {
  const { t } = await loadThread(db, threadId);
  await updateThread(db, t, { needsHuman: null, openQuestions: [] });
}

export async function testMailbox(mb: Mailbox): Promise<string | null> {
  try {
    await transportFor(mb).verify();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ---------- фоновий виконавець ---------- */

const llmReady = () => Date.now() >= state.llmPausedUntil;

async function withLlmPause<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LlmUnavailableError) {
      state.llmPausedUntil = (e.retryAt?.getTime() ?? Date.now() + 60_000) + 1000;
      return null;
    }
    throw e;
  }
}

/** Один крок листування. true — щось зроблено (виконавець одразу спробує ще). */
export async function runOutreach(db: Db): Promise<boolean> {
  const now = new Date();
  let worked = false;

  for (const mb of await db.select().from(mailboxes)) {
    if (Date.now() - (state.lastPoll.get(mb.id) ?? 0) < POLL_EVERY_MS) continue;
    state.lastPoll.set(mb.id, Date.now());
    if ((await pollMailbox(db, mb)) > 0) worked = true;
  }

  if (llmReady()) {
    // Розбір нової відповіді автора.
    const [inbound] = await db.select({ id: outreachMessages.id, threadId: outreachMessages.threadId }).from(outreachMessages)
      .where(and(eq(outreachMessages.status, "received"), sql`coalesce(${outreachMessages.ai}->>'processed', 'false') <> 'true'`))
      .orderBy(asc(outreachMessages.createdAt)).limit(1);
    if (inbound) {
      try {
        if ((await withLlmPause(() => handleInbound(db, inbound.id))) != null) worked = true;
      } catch (e) {
        console.error("Розбір відповіді автора не вдався:", e);
        await db.update(outreachMessages).set({ ai: { processed: true, error: e instanceof Error ? e.message : String(e) } }).where(eq(outreachMessages.id, inbound.id));
        await db.update(outreachThreads).set({ needsHuman: "Не вдалося розібрати відповідь автора — прочитайте її самі" }).where(eq(outreachThreads.id, inbound.threadId));
      }
    }
  }

  if (llmReady()) {
    // Перший лист для нового листування.
    const [fresh] = await db.select().from(outreachThreads)
      .where(and(eq(outreachThreads.status, "draft"), lte(outreachThreads.nextActionAt, now), isNull(outreachThreads.needsHuman)))
      .orderBy(asc(outreachThreads.createdAt)).limit(1);
    if (fresh) {
      try {
        if ((await withLlmPause(() => generateFirst(db, fresh))) !== null) worked = true;
      } catch (e) {
        await db.update(outreachThreads).set({ needsHuman: `Не вдалося написати перший лист: ${e instanceof Error ? e.message : e}`, nextActionAt: null })
          .where(eq(outreachThreads.id, fresh.id));
      }
    }
  }

  // Строки: нагадування мовчазним авторам і перевірка дописів.
  const [due] = await db.select().from(outreachThreads)
    .where(and(inArray(outreachThreads.status, ["sent", "shipped"]), lte(outreachThreads.nextActionAt, now), isNull(outreachThreads.needsHuman)))
    .orderBy(asc(outreachThreads.nextActionAt)).limit(1);
  if (due) {
    try {
      if (due.status === "sent") await queueFollowup(db, due);
      else if (llmReady()) await withLlmPause(() => checkPost(db, due.id));
      worked = true;
    } catch (e) {
      await db.update(outreachThreads).set({ needsHuman: `Автоматична дія не вдалася: ${e instanceof Error ? e.message : e}`, nextActionAt: null })
        .where(eq(outreachThreads.id, due.id));
    }
  }

  if (await sendNext(db)) worked = true;
  return worked;
}

/* ---------- звіт клієнта ---------- */

export type ClientReport = {
  byStatus: Record<string, number>;
  contacted: number; replied: number; agreed: number; shipped: number; posted: number; disclosureMissing: number;
  needsHuman: number; autoHandled: number; humanHandled: number;
  costUsd: number; feesUsd: number;
  posts: { creatorId: number; username: string; url: string; postedAt: Date | null; disclosure: boolean | null; feeUsd: number | null }[];
};

export async function clientReport(db: Db, clientId: number): Promise<ClientReport> {
  const threads = await db.select({ t: outreachThreads, username: creators.username }).from(outreachThreads)
    .innerJoin(creators, eq(creators.id, outreachThreads.creatorId)).where(eq(outreachThreads.clientId, clientId));
  const byStatus: Record<string, number> = {};
  for (const { t } of threads) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const ids = threads.map((x) => x.t.id);
  const replies = ids.length
    ? await db.select({ kind: outreachMessages.kind, status: outreachMessages.status }).from(outreachMessages)
      .where(and(inArray(outreachMessages.threadId, ids), eq(outreachMessages.direction, "out"), eq(outreachMessages.status, "sent")))
    : [];
  const [cost] = await db.select({ usd: sql<number>`coalesce(sum((${searches.stats}->>'costUsd')::float), 0)` }).from(searches).where(eq(searches.clientId, clientId));
  const any = (...s: ThreadStatus[]) => threads.filter(({ t }) => s.includes(t.status)).length;
  const posted = threads.filter(({ t }) => t.status === "posted");
  return {
    byStatus,
    contacted: threads.filter(({ t }) => t.lastOutboundAt).length,
    replied: threads.filter(({ t }) => t.lastInboundAt).length,
    agreed: any("agreed", "to_ship", "shipped", "posted"),
    shipped: any("shipped", "posted"),
    posted: posted.length,
    disclosureMissing: posted.filter(({ t }) => t.postCheck?.disclosure === false).length,
    needsHuman: threads.filter(({ t }) => t.needsHuman).length,
    autoHandled: replies.filter((r) => r.kind === "reply" || r.kind === "followup").length,
    humanHandled: replies.filter((r) => r.kind === "manual").length,
    costUsd: cost?.usd ?? 0,
    feesUsd: posted.reduce((a, { t }) => a + (t.terms?.feeUsd ?? 0), 0),
    posts: posted.map(({ t, username }) => ({
      creatorId: t.creatorId, username, url: t.postUrl ?? "", postedAt: t.postedAt, disclosure: t.postCheck?.disclosure ?? null, feeUsd: t.terms?.feeUsd ?? null,
    })),
  };
}
