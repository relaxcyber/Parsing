import { redirect } from "next/navigation";
import { logout, requireAuth } from "@/lib/auth";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await logout();
  redirect("/login");
}

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Parsing</div>
        <Nav />
        <span className="soon">Вітрина · скоро</span>
        <form action={signOut}>
          <button className="link">Вийти</button>
        </form>
      </nav>
      <main>{children}</main>
    </div>
  );
}
