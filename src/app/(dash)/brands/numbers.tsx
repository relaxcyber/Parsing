import { ratesText, sizeText, type BrandMetrics } from "@/brands/collabs";

/** Цифри бренду: усе пораховано кодом з публічних рекламних дописів. */
export function Numbers({ m }: { m: BrandMetrics }) {
  return (
    <>
      <b>{m.creators}</b> автор(ів){m.active90 > 0 && <span className="risk-low"> · {m.active90} за 90 днів</span>}
      <div className="muted">
        {m.repeatCreators > 0 && <>повторно: {m.repeatCreators} · </>}
        {m.paidPosts > 0 && <>платне партнерство: {m.paidPosts} · </>}
        {m.lastAt && <>остання: {m.lastAt.slice(0, 10)}</>}
      </div>
      {m.followers && <div className="muted">розмір авторів: {sizeText(m).replace("median", "медіана")}</div>}
      {m.adEr != null && <div className="muted">ER реклами: {m.adEr}%</div>}
      {m.rates && <div className="muted">ставки авторів: {ratesText(m).replace("creators", "авт.")}</div>}
      <div className="muted">
        {m.examples.map((c, i) => <span key={c.postUrl}>{i > 0 && ", "}<a href={c.postUrl} target="_blank" rel="noreferrer">@{c.creator}</a></span>)}
      </div>
    </>
  );
}
