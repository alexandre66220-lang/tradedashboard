export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  "1": "Mot de passe incorrect.",
  locked: "Trop de tentatives. Accès bloqué pendant au moins 15 minutes.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <main className="login">
      <form action="/api/login" method="post">
        <h1>Market Dashboard</h1>
        <input type="password" name="password" placeholder="Mot de passe" autoComplete="current-password" required autoFocus />
        {e && MESSAGES[e] && <p className="err">{MESSAGES[e]}</p>}
        <button type="submit">Entrer</button>
      </form>
    </main>
  );
}
