"use client";

import { countdown, relevantEvents, type CalendarEvent, type NewsProfile } from "@/lib/calendar";

interface Props {
  events: CalendarEvent[] | null;
  stale: boolean;
  error: string | null;
  profile: NewsProfile;
  name: string;
}

const day = (sec: number) => new Date(sec * 1000).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
const hour = (sec: number) => new Date(sec * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export default function CalendarPanel({ events, stale, error, profile, name }: Props) {
  const now = Math.floor(Date.now() / 1000);
  const list = events ? relevantEvents(events, profile, now, -30, 7 * 24 * 60).slice(0, 10) : [];
  const currencies = (profile.newsCurrencies ?? ["USD"]).join(", ");

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Annonces à venir</span>
        <span className="tag">{name.split(" ")[0]}</span>
      </div>
      {error && !events && <p className="muted small">Calendrier indisponible : {error}</p>}
      {!error && !events && <p className="muted small">Chargement…</p>}
      {stale && <p className="muted small">Données un peu anciennes : la dernière mise à jour du calendrier a échoué.</p>}
      {events && list.length === 0 && <p className="muted small">Aucune annonce importante ({currencies}) dans les 7 prochains jours.</p>}
      {list.length > 0 && (
        <ul className="news">
          {list.map((e) => (
            <li key={e.id}>
              <span className={`imp ${e.impact}`} title={e.impact === "high" ? "Impact fort" : "Impact moyen"} />
              <div>
                <div className="trow">
                  <strong>{e.title}</strong>
                  <span className="muted small">{e.currency}</span>
                </div>
                <div className="muted small">
                  {day(e.time)} {hour(e.time)} · {countdown(e.minutesFromNow)}
                  {e.forecast ? ` · prévu ${e.forecast}` : ""}
                  {e.previous ? ` · précédent ${e.previous}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="disclaimer">
        Annonces économiques d’impact moyen ou fort qui font bouger cet instrument ({currencies}
        {profile.newsKeywords?.length ? ` + titres contenant « ${profile.newsKeywords.join(" », « ")} »` : ""}). Autour d’une annonce forte, les prix
        sautent et le spread s’élargit : le feu passe au rouge 30 minutes avant et après. Source externe gratuite, les horaires peuvent changer.
      </p>
    </section>
  );
}
