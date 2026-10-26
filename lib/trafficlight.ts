import type { Candle } from "./types";

export type Light = "green" | "orange" | "red";

export interface Reason {
  level: "red" | "orange" | "info";
  text: string;
}

export interface LightInput {
  marketStatus: string | undefined;
  quote: { bid: number; offer: number } | null | undefined;
  /** Spread assumed in config/instruments.ts, in basis points */
  assumedSpreadBps: number;
  candles: Candle[];
  /** Resolution of the candles, in minutes (to detect stale data) */
  resMinutes: number;
  /** Result of the trades closed today */
  todayPnl: number;
  /** Maximum acceptable loss for the day, as a positive amount (null = not set) */
  dailyLossLimit: number | null;
  /** UTC seconds */
  now: number;
  /** Economic announcements that matter for this instrument (see lib/calendar) */
  news?: Array<{ title: string; minutesFromNow: number; impact: "high" | "medium" }>;
}

export interface LightResult {
  light: Light;
  reasons: Reason[];
  spreadBps: number | null;
  /** 0..1: where the current volatility (ATR 14) sits among the loaded history */
  atrPercentile: number | null;
  /** Whether the economic calendar was part of the check */
  newsChecked: boolean;
}

/** ATR(14) series over completed candles (the forming one is ignored). */
function atrSeries(candles: Candle[], period = 14): number[] {
  const done = candles.slice(0, -1);
  const tr: number[] = [];
  for (let i = 1; i < done.length; i++) {
    const c = done[i], prev = done[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out.push(sum / period);
  }
  return out;
}

export function atrPercentile(candles: Candle[]): number | null {
  const s = atrSeries(candles).slice(-500);
  if (s.length < 100) return null;
  const current = s[s.length - 1];
  // mid-rank: ties count for half, so a perfectly constant volatility sits in the middle, not at the top
  const below = s.filter((v) => v < current).length;
  const equal = s.filter((v) => v === current).length;
  return (below + equal / 2) / s.length;
}

const money = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

export function trafficLight(i: LightInput): LightResult {
  const reasons: Reason[] = [];
  const closed = i.marketStatus !== undefined && i.marketStatus !== "TRADEABLE" && i.marketStatus !== "UNKNOWN";
  if (closed) reasons.push({ level: "red", text: "Marché fermé (week-end ou hors séance) : les prix affichés ne bougent pas." });

  let spreadBps: number | null = null;
  if (i.quote && i.quote.offer >= i.quote.bid) {
    const mid = (i.quote.offer + i.quote.bid) / 2;
    spreadBps = ((i.quote.offer - i.quote.bid) / mid) * 1e4;
    const ratio = i.assumedSpreadBps > 0 ? spreadBps / i.assumedSpreadBps : 1;
    if (ratio >= 3) reasons.push({ level: "red", text: `Spread très large : ${spreadBps.toFixed(1)} points de base, soit ${ratio.toFixed(1)} fois le spread habituel.` });
    else if (ratio >= 1.8) reasons.push({ level: "orange", text: `Spread élargi : ${spreadBps.toFixed(1)} points de base (habituellement ${i.assumedSpreadBps}).` });
  }

  const pct = atrPercentile(i.candles);
  if (!closed && pct !== null) {
    if (pct >= 0.9) reasons.push({ level: "orange", text: "Marché très agité : volatilité parmi les 10 % les plus fortes de l'historique chargé. Les stops sautent plus facilement." });
    else if (pct <= 0.1) reasons.push({ level: "orange", text: "Marché très calme : peu de mouvement, donc le spread pèse davantage sur chaque trade." });
  }

  const last = i.candles.at(-1);
  if (!closed && last && i.now - last.time > i.resMinutes * 60 * 4) {
    reasons.push({ level: "orange", text: "Données en retard : la dernière bougie est ancienne. Vérifiez la connexion avant de vous fier au graphique." });
  }

  if (i.dailyLossLimit !== null && i.dailyLossLimit > 0) {
    if (i.todayPnl <= -i.dailyLossLimit) {
      reasons.push({ level: "red", text: `Perte maximale du jour atteinte (${money(i.todayPnl)} $ pour une limite de ${money(i.dailyLossLimit)} $). Arrêtez pour aujourd'hui.` });
    } else if (i.todayPnl <= -0.5 * i.dailyLossLimit) {
      reasons.push({ level: "orange", text: `Déjà la moitié de la perte maximale du jour (${money(i.todayPnl)} $ sur ${money(i.dailyLossLimit)} $).` });
    }
  }

  for (const n of i.news ?? []) {
    const m = Math.round(n.minutesFromNow);
    const when = m >= 0 ? `dans ${m} min` : `il y a ${-m} min`;
    if (n.impact === "high" && Math.abs(n.minutesFromNow) <= 30) {
      reasons.push({ level: "red", text: `Annonce majeure ${when} : ${n.title}. Les prix peuvent sauter, le spread s'élargit.` });
    } else if (Math.abs(n.minutesFromNow) <= 90) {
      reasons.push({ level: "orange", text: `Annonce ${when} : ${n.title}.` });
    }
  }

  const light: Light = reasons.some((r) => r.level === "red") ? "red" : reasons.some((r) => r.level === "orange") ? "orange" : "green";
  return { light, reasons, spreadBps, atrPercentile: pct, newsChecked: i.news !== undefined };
}
