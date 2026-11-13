"use client";

import { useRef, useState, useTransition } from "react";
import { createSearch, saveTemplate, suggestBrief } from "./actions";
import { LANGS } from "./labels";

type Values = Record<string, string>;

/** Значення за замовчуванням — ті самі, що й у коді пошуку (src/search/criteria.ts). */
const DEFAULTS: Values = {
  focus: "ugc", platform: "instagram", outreachLanguage: "en", postsPerTag: "50", maxProfiles: "150", auditLimit: "30", deepLimit: "10", commentsLimit: "0",
  excludeContacted: "on", "c.followers": "required", "c.country": "required", "c.language": "required", "c.activity": "required",
  activityDays: "30", "c.er": "off", erMinPct: "1", "c.email": "preferred", "c.ads": "off", "c.trust": "required", trustMaxRisk: "medium",
  "c.formats": "off", formats: "", qualityMin: "40", qualityLead: "70",
  "w.fit": "1", "w.quality": "1", "w.readiness": "1", "w.trust": "1", "w.match": "1",
};

const FORMATS = [
  ["talking_to_camera", "говорить у камеру"],
  ["product_demo", "показує товар у дії"],
  ["voiceover", "закадровий голос"],
  ["subtitles", "субтитри"],
] as const;

function Mode({ name, v }: { name: string; v: Values }) {
  return (
    <select name={name} defaultValue={v[name] ?? "off"} aria-label="Як враховувати">
      <option value="required">обов’язково</option>
      <option value="preferred">бажано</option>
      <option value="off">не важливо</option>
    </select>
  );
}

function Weight({ name, label, v }: { name: string; label: string; v: Values }) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={v[name] ?? "1"}>
        <option value="0">не враховувати</option>
        <option value="1">звичайна</option>
        <option value="2">важлива</option>
        <option value="3">головна</option>
      </select>
    </label>
  );
}

export function SearchForm({ templates, clients = [] }: { templates: { name: string; data: Values }[]; clients?: { id: number; name: string }[] }) {
  const ref = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [formKey, setFormKey] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [tplName, setTplName] = useState("");
  const [pending, start] = useTransition();

  /** Поточні значення форми — щоб не втратити набране, коли застосовуємо шаблон чи пропозицію. */
  const current = (): Values => {
    const f = new FormData(ref.current!);
    const out: Values = {};
    for (const [k, val] of f.entries()) if (typeof val === "string" && k !== "formats" && !k.startsWith("$")) out[k] = val;
    out.formats = f.getAll("formats").map(String).join(",");
    out.excludeContacted = f.has("excludeContacted") ? "on" : "";
    return out;
  };
  const apply = (patch: Values) => {
    setValues({ ...current(), ...patch });
    setFormKey((k) => k + 1);
  };

  const applyTemplate = (name: string) => {
    const t = templates.find((x) => x.name === name);
    if (!t) return;
    const cur = current();
    apply({ ...DEFAULTS, ...t.data, name: cur.name, brief: cur.brief || t.data.brief || "" });
    setMsg(`Застосовано шаблон «${name}» — перевірте поля перед запуском.`);
  };

  const fromBrief = () => {
    const cur = current();
    setMsg(null);
    start(async () => {
      const r = await suggestBrief(cur.brief ?? "", cur.focus === "affiliate" ? "affiliate" : "ugc");
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      const d = r.data;
      const keep = (k: string, next: string) => (next ? next : cur[k] ?? "");
      apply({
        hashtags: keep("hashtags", d.hashtags.join(", ")), keywords: keep("keywords", d.keywords.join(", ")),
        stopWords: keep("stopWords", d.stopWords.join(", ")), bioQueries: keep("bioQueries", d.bioQueries.join("\n")),
        competitors: keep("competitors", d.competitors.join("\n")), countries: keep("countries", d.countries.join(", ")),
        languages: keep("languages", d.languages.join(", ")), formats: keep("formats", d.formats.join(",")),
        "c.formats": d.formats.length ? "preferred" : cur["c.formats"],
      });
      setMsg(`Модель запропонувала параметри — це чернетка, виправте її під себе.${d.notes ? ` Порада: ${d.notes}` : ""}`);
    });
  };

  const save = () => {
    const data = current();
    start(async () => {
      const r = await saveTemplate(tplName, data);
      setMsg(r.ok ? `Шаблон «${tplName.trim()}» збережено` : r.error ?? "Не вдалося зберегти");
    });
  };

  const v = values;
  const fmts = new Set((v.formats ?? "").split(",").filter(Boolean));
  return (
    <>
      {msg && <div className="flash" role="status">{msg}</div>}
      <form ref={ref} action={createSearch} key={formKey} className="search-form">
        <fieldset>
          <legend>Що шукаємо</legend>
          <div className="grid">
            <label>Назва<input name="name" required maxLength={80} placeholder="напр. Косметика, осінь" defaultValue={v.name} /></label>
            <label>
              Платформа
              <select name="platform" defaultValue={v.platform}>
                <option value="instagram">Instagram (Apify)</option>
                <option value="tiktok">TikTok (безкоштовно: ваш список, вебпошук, з бази Instagram)</option>
              </select>
            </label>
            <label>
              Кого шукаємо
              <select name="focus" defaultValue={v.focus}>
                <option value="ugc">UGC-креаторів (знімають на замовлення)</option>
                <option value="affiliate">Афіліатів (вітрини, промокоди)</option>
              </select>
            </label>
            <label>
              Шаблон
              <select defaultValue="" onChange={(e) => applyTemplate(e.target.value)} name="$template">
                <option value="">— без шаблону —</option>
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </label>
          </div>
          <label className="wide">
            Бриф: бізнес, товар, ринок, який автор потрібен
            <textarea name="brief" rows={4} defaultValue={v.brief} placeholder="Напр.: бренд натуральної косметики для догляду за шкірою, ринок США. Потрібні жінки 25–40, що знімають догляд у камеру, з субтитрами. Конкуренти: @drunkelephant." />
          </label>
          <div className="actions">
            <button type="button" onClick={fromBrief} disabled={pending}>{pending ? "Думаю…" : "Заповнити з брифу"}</button>
            <span className="muted">Модель запропонує хештеги, слова ніші, запити для пошуку й критерії. Бриф також бачать аналітик профілів і автор листів.</span>
          </div>
        </fieldset>

        <fieldset>
          <legend>Де шукати</legend>
          <p className="muted">Потрібне хоча б одне джерело. Кожне джерело платне в Apify, крім вашого списку; веб-пошук витрачає кредити Firecrawl.</p>
          <div className="grid">
            <label>Хештеги (через кому)<input name="hashtags" placeholder="ugccreator, skincareugc" defaultValue={v.hashtags} /></label>
            <label>Пошук профілів за словами (по рядку)<textarea name="bioQueries" rows={2} placeholder={"ugc creator skincare\nbeauty content creator"} defaultValue={v.bioQueries} /></label>
            <label>Бренди-конкуренти: хто їх відмічає (по рядку)<textarea name="competitors" rows={2} placeholder="@brand" defaultValue={v.competitors} /></label>
            <label>Зразки: схожі на цих авторів (по рядку)<textarea name="seeds" rows={2} placeholder="@ideal.creator" defaultValue={v.seeds} /></label>
            <label>Місця: місто, район, заклад (по рядку)<textarea name="places" rows={2} placeholder="Kyiv" defaultValue={v.places} /></label>
            <label>Пошук у вебі (по рядку)<textarea name="webQueries" rows={2} placeholder={'site:instagram.com "ugc creator" skincare'} defaultValue={v.webQueries} /></label>
          </div>
          <label className="wide">Готовий список імен — перевірити базу (по рядку чи через кому)<textarea name="usernames" rows={2} placeholder="@anna.creates, @ben.films" defaultValue={v.usernames} /></label>
        </fieldset>

        <fieldset>
          <legend>Критерії</legend>
          <p className="muted">«Обов’язково» відсіює (якщо даних немає — автор проходить з позначкою), «бажано» піднімає в рейтингу, «не важливо» — не враховується.</p>
          <div className="crit">
            <span>Аудиторія</span><Mode name="c.followers" v={v} />
            <span className="inline"><input name="minFollowers" type="number" min="0" placeholder="від, напр. 1000" defaultValue={v.minFollowers} /><input name="maxFollowers" type="number" min="0" placeholder="до, напр. 100000" defaultValue={v.maxFollowers} /></span>
            <span>Країна</span><Mode name="c.country" v={v} /><input name="countries" placeholder="коди: US, GB" defaultValue={v.countries} />
            <span>Мова контенту</span><Mode name="c.language" v={v} /><input name="languages" placeholder="коди: en" defaultValue={v.languages} />
            <span>Активність</span><Mode name="c.activity" v={v} />
            <label className="row">допис не давніше, днів<input name="activityDays" type="number" min="1" max="365" defaultValue={v.activityDays} /></label>
            <span>Залученість</span><Mode name="c.er" v={v} />
            <label className="row">вподобання від, % аудиторії<input name="erMinPct" type="number" min="0" max="50" step="0.1" defaultValue={v.erMinPct} /></label>
            <span>Довіра до аудиторії</span><Mode name="c.trust" v={v} />
            <label className="row">
              допустимий ризик накрутки
              <select name="trustMaxRisk" defaultValue={v.trustMaxRisk}><option value="low">лише низький</option><option value="medium">низький або середній</option></select>
            </label>
            <span>Досвід реклами</span><Mode name="c.ads" v={v} /><span className="muted">є рекламні дописи серед останніх</span>
            <span>Email</span><Mode name="c.email" v={v} /><span className="muted">особистий або на власному домені</span>
            <span>Формат роликів</span><Mode name="c.formats" v={v} />
            <span className="checks">
              {FORMATS.map(([k, label]) => (
                <label key={k} className="check"><input type="checkbox" name="formats" value={k} defaultChecked={fmts.has(k)} />{label}</label>
              ))}
            </span>
          </div>
          <div className="grid" style={{ marginTop: 12 }}>
            <label>Слова ніші (через кому)<input name="keywords" placeholder="skincare, makeup, beauty" defaultValue={v.keywords} /></label>
            <label>Стоп-слова (через кому)<input name="stopWords" placeholder="giveaway, shop" defaultValue={v.stopWords} /></label>
            <label>Якість візуалу: відхиляти нижче<input name="qualityMin" type="number" min="0" max="100" defaultValue={v.qualityMin} /></label>
            <label>«Готовий лід» від якості<input name="qualityLead" type="number" min="0" max="100" defaultValue={v.qualityLead} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Обсяг, бюджет, автопілот</legend>
          <div className="grid">
            <label>Дописів на джерело<input name="postsPerTag" type="number" min="5" max="200" defaultValue={v.postsPerTag} required /></label>
            <label>Профілів щонайбільше<input name="maxProfiles" type="number" min="1" max="500" defaultValue={v.maxProfiles} required /></label>
            <label>Візуальний аудит для найкращих<input name="auditLimit" type="number" min="0" max="150" defaultValue={v.auditLimit} required /></label>
            <label>Розбір роликів і мовлення<input name="deepLimit" type="number" min="0" max="50" defaultValue={v.deepLimit} required /></label>
            <label>Розбір коментарів (платно)<input name="commentsLimit" type="number" min="0" max="50" defaultValue={v.commentsLimit} required /></label>
            <label>Мета: готових лідів<input name="targetLeads" type="number" min="1" placeholder="напр. 30" defaultValue={v.targetLeads} /></label>
            <label>Бюджет Apify, $<input name="budgetUsd" type="number" min="0" step="0.1" placeholder="напр. 3" defaultValue={v.budgetUsd} /></label>
            <label>Повторювати кожні, днів<input name="repeatDays" type="number" min="1" max="90" placeholder="без повтору" defaultValue={v.repeatDays} /></label>
          </div>
          <label className="check"><input type="checkbox" name="excludeContacted" defaultChecked={v.excludeContacted === "on"} />Не показувати авторів, яким уже писали</label>
          <p className="muted">З метою пошук іде джерело за джерелом і зупиняється, щойно знайдено потрібну кількість лідів; коли джерела скінчаться, додасть хештеги, знайдені в дописах авторів, що пройшли відбір. Бюджет — стеля витрат Apify на весь пошук. Розбір коментарів — близько $0,08 на автора.</p>
        </fieldset>

        <details>
          <summary>Вага індексів у загальній оцінці</summary>
          <div className="grid" style={{ marginTop: 10 }}>
            <Weight name="w.fit" label="Ніша й роль" v={v} />
            <Weight name="w.quality" label="Якість візуалу" v={v} />
            <Weight name="w.readiness" label="Готовість (контакт, прайс)" v={v} />
            <Weight name="w.trust" label="Довіра до аудиторії" v={v} />
            <Weight name="w.match" label="Бажані критерії" v={v} />
          </div>
        </details>

        <fieldset>
          <legend>Листи</legend>
          <div className="grid">
            <label>
              Мова листів
              <select name="outreachLanguage" defaultValue={v.outreachLanguage}>
                {Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label>Бренд (для листа)<input name="brandName" maxLength={80} placeholder="напр. Glow Lab" defaultValue={v.brandName} /></label>
            <label>
              Клієнт (листування й звіт)
              <select name="clientId" defaultValue="">
                <option value="">— без клієнта —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <label className="wide">Умови співпраці — модель не назве в листі інших цифр<textarea name="offer" rows={2} placeholder="напр. 3 відео до 30 с, $150 за відео, права на рекламу 3 місяці" defaultValue={v.offer} /></label>
          <label className="wide">Приклад листа, тон якого вам подобається (необов’язково)<textarea name="letterExample" rows={3} defaultValue={v.letterExample} /></label>
        </fieldset>

        <div className="actions">
          <button className="primary" disabled={pending}>Запустити пошук</button>
          <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="назва шаблону" aria-label="Назва шаблону" name="$tplName" />
          <button type="button" onClick={save} disabled={pending || tplName.trim().length < 2}>Зберегти як шаблон</button>
        </div>
      </form>
    </>
  );
}
