import { redirect } from "next/navigation";
import { isAuthed, login, loginLockSeconds } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signIn(form: FormData) {
  "use server";
  const r = await login(String(form.get("password") ?? ""));
  redirect(r.ok ? "/search" : `/login?error=${r.reason}`);
}

const wait = (sec: number) => (sec >= 90 ? `${Math.ceil(sec / 60)} хв` : `${sec} с`);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAuthed()) redirect("/search");
  const { error } = await searchParams;
  const locked = loginLockSeconds();
  return (
    <div className="card login">
      <h1>Вхід</h1>
      <p className="sub">Панель керування шлюзом даних</p>
      {locked > 0 ? (
        <div className="flash" role="alert">Забагато невдалих спроб. Спробуйте знову через {wait(locked)}.</div>
      ) : (
        error && <div className="flash" role="alert">Неправильний пароль</div>
      )}
      <form action={signIn}>
        <label>
          Пароль
          <input type="password" name="password" required autoFocus autoComplete="current-password" />
        </label>
        <button className="primary">Увійти</button>
      </form>
    </div>
  );
}
