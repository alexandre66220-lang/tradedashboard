import "server-only";
import { INSTRUMENTS } from "@/config/instruments";
import { lastBackup } from "@/lib/backup";
import { CapitalError, capitalEnv, getMarketQuote } from "@/lib/capital";
import { getCalendar } from "@/lib/calendar-source";
import { journalOverview } from "@/lib/journal/service";
import { getStorage } from "@/lib/journal/storage";
import { notifyConfigured } from "@/lib/notify";
import { readList } from "@/lib/store";

export type HealthStatus = "ok" | "warn" | "error" | "off";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  generatedAt: number;
  /** Worst status of the checks that matter (those that are "off" are left out) */
  overall: Exclude<HealthStatus, "off">;
  checks: HealthCheck[];
}

/** A journal that records on every visit and every 30 minutes should never be silent for long. */
export const JOURNAL_SILENT_WARN_MS = 90 * 60_000;
export const JOURNAL_SILENT_ERROR_MS = 6 * 3600_000;

const TIMEOUT_MS = 8_000;

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 90) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} jours`;
}

async function guard(id: string, label: string, fn: () => Promise<Omit<HealthCheck, "id" | "label">>): Promise<HealthCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([fn(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)))]);
    return { id, label, ...out };
  } catch (err) {
    // Messages of our own code and of fetch ("fetch failed", "calendar feed returned 403"): no secret in them
    const detail =
      err instanceof CapitalError
        ? err.message
        : err instanceof Error && err.message === "timeout"
          ? "Pas de réponse en 8 s."
          : err instanceof Error && err.message
            ? `Vérification impossible : ${err.message.slice(0, 120)}.`
            : "Vérification impossible.";
    return { id, label, status: "error", detail };
  } finally {
    clearTimeout(timer);
  }
}

const checkCapital = () =>
  guard("capital", "Capital.com", async () => {
    const q = await getMarketQuote(INSTRUMENTS[0].epic);
    return { status: "ok", detail: `Connecté (${capitalEnv() === "live" ? "réel" : "démo"}), marché ${q.status === "TRADEABLE" ? "ouvert" : "fermé"}.` };
  });

const checkModel = () =>
  guard("model", "Service de prévision (ML)", async () => {
    const url = process.env.FORECAST_SERVICE_URL;
    if (!url) return { status: "off", detail: "Non configuré : le modèle intégré est utilisé (FORECAST_SERVICE_URL absent)." };
    const missing = process.env.FORECAST_SERVICE_TOKEN ? "" : " FORECAST_SERVICE_TOKEN est absent : le service refusera les demandes.";
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return { status: "error", detail: `Le service répond avec une erreur (HTTP ${res.status}).${missing}` };
    return missing ? { status: "warn", detail: `Le service répond.${missing}` } : { status: "ok", detail: "Le service répond." };
  });

const checkStorage = () =>
  guard("storage", "Stockage (journal, trades, alertes)", async () => {
    if (!getStorage()) return { status: "error", detail: "Aucun stockage configuré : le journal, les trades et les alertes ne sont pas enregistrés." };
    await readList("health/ping");
    const which = process.env.STORAGE_BACKEND || (process.env.NETLIFY_BLOBS_CONTEXT ? "netlify" : process.env.BLOB_READ_WRITE_TOKEN ? "vercel" : "mémoire");
    return { status: "ok", detail: `Lecture possible (${which === "netlify" ? "Netlify Blobs" : which === "vercel" ? "Vercel Blob" : "mémoire locale, non durable"}).` };
  });

const checkJournal = () =>
  guard("journal", "Journal des prévisions", async () => {
    const o = await journalOverview();
    if (!o.configured) return { status: "off", detail: "Pas de stockage : journal inactif." };
    const a = o.activity;
    if (!a || a.lastRecordedAt === null) return { status: "warn", detail: "Aucune prévision enregistrée pour l'instant. Ouvrez le graphique, ou vérifiez que la tâche planifiée tourne." };
    const silent = Date.now() - a.lastRecordedAt;
    const base = `Dernier relevé ${ago(silent)} · ${a.last24h} prévisions sur 24 h · ${a.total} au total.`;
    if (silent > JOURNAL_SILENT_ERROR_MS) return { status: "error", detail: `${base} Plus de relevé depuis longtemps : les tâches planifiées ne tournent sans doute pas (CRON_SECRET ?).` };
    if (silent > JOURNAL_SILENT_WARN_MS) return { status: "warn", detail: `${base} Pas de relevé récent : normal si le site est fermé et que la tâche planifiée est lente.` };
    return { status: "ok", detail: base };
  });

const BACKUP_STALE_MS = 36 * 3600_000;

const checkBackup = () =>
  guard("backup", "Sauvegarde du journal", async () => {
    if (!getStorage()) return { status: "off", detail: "Pas de stockage : rien à sauvegarder." };
    const b = await lastBackup();
    if (!b) return { status: "warn", detail: "Aucune sauvegarde pour l'instant (la première est faite chaque nuit vers 3 h 30 UTC). Vous pouvez en télécharger une à la main ci-dessous." };
    const age = Date.now() - b.at;
    return age > BACKUP_STALE_MS
      ? { status: "warn", detail: `Dernière sauvegarde du ${new Date(b.at).toLocaleDateString("fr-FR")} : la tâche quotidienne ne semble pas tourner.` }
      : { status: "ok", detail: `Dernière sauvegarde du ${new Date(b.at).toLocaleDateString("fr-FR")} (14 jours conservés).` };
  });

const checkCalendar = () =>
  guard("calendar", "Calendrier des annonces", async () => {
    const c = await getCalendar();
    return c.stale
      ? { status: "warn", detail: `Source injoignable : dernières données ${ago(Date.now() - c.updatedAt)}.` }
      : { status: "ok", detail: `${c.events.length} annonces chargées, mises à jour ${ago(Date.now() - c.updatedAt)}.` };
  });

/** Settings that are only booleans here: the values themselves never leave the server. */
const checkSettings = () =>
  guard("settings", "Réglages", async () => {
    const missing: string[] = [];
    if (!process.env.CRON_SECRET) missing.push("CRON_SECRET (tâches automatiques et alertes)");
    if (!notifyConfigured()) missing.push("NTFY_TOPIC (alertes sur téléphone)");
    return missing.length
      ? { status: "warn", detail: `Manquant : ${missing.join(", ")}.` }
      : { status: "ok", detail: "CRON_SECRET et NTFY_TOPIC sont définis." };
  });

const ORDER: Record<HealthStatus, number> = { off: 0, ok: 1, warn: 2, error: 3 };

export async function healthReport(): Promise<HealthReport> {
  const checks = await Promise.all([checkCapital(), checkModel(), checkStorage(), checkJournal(), checkBackup(), checkCalendar(), checkSettings()]);
  const worst = checks.reduce<HealthStatus>((w, c) => (ORDER[c.status] > ORDER[w] ? c.status : w), "ok");
  return { generatedAt: Date.now(), overall: worst === "off" ? "ok" : worst, checks };
}
