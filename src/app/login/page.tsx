import { redirect } from "next/navigation";
import { isAuthed, login } from "@/lib/auth";

async function signIn(form: FormData) {
  "use server";
  const ok = await login(String(form.get("password") ?? ""));
  redirect(ok ? "/keys" : "/login?error=1");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAuthed()) redirect("/keys");
  const { error } = await searchParams;
  return (
    <div className="card login">
      <h1>Вхід</h1>
      <p className="sub">Панель керування шлюзом даних</p>
      {error && <div className="flash" role="alert">Невірний пароль</div>}
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
