import type { BrandCreator } from "@/db/schema";

/** Поля креатора: з них ІІ пише листи брендам і не додає нічого понад це. */
export function CreatorFields({ c }: { c: BrandCreator | null }) {
  return (
    <>
      <div className="grid">
        <label>Ім’я (підпис)<input name="c_name" maxLength={60} defaultValue={c?.name ?? ""} placeholder="Anna" /></label>
        <label>Instagram креатора<input name="c_handle" maxLength={60} defaultValue={c?.handle ?? ""} placeholder="@anna.ugc" /></label>
        <label>Ніша (англійською)<input name="c_niche" maxLength={120} defaultValue={c?.niche ?? ""} placeholder="dog care, pet food" /></label>
        <label>Підписники (як написати в листі)<input name="c_followers" maxLength={30} defaultValue={c?.followers ?? ""} placeholder="12K" /></label>
      </div>
      <label className="wide">Хто креатор (англійською, 1–2 речення)<textarea name="c_about" rows={2} maxLength={600} defaultValue={c?.about ?? ""} placeholder="I film short UGC videos with my two corgis: unboxings, feeding routines, product demos." /></label>
      <label className="wide">Що пропонує бренду (англійською)<textarea name="c_offer" rows={2} maxLength={600} defaultValue={c?.offer ?? ""} placeholder="A 30-60 sec UGC video they can use in ads, delivered in 7 days." /></label>
      <label className="wide">Портфоліо (посилання)<input name="c_portfolio" maxLength={300} defaultValue={c?.portfolio ?? ""} placeholder="https://anna.my.canva.site" /></label>
      <label className="wide">Стиль (необов’язково): 2–3 справжні повідомлення креатора англійською, розділені рядком ---
        <textarea name="c_style" rows={3} maxLength={4000} defaultValue={c?.style ?? ""} />
      </label>
    </>
  );
}
