export type TradeSide = "long" | "short";

export interface TradeModel {
  direction: "up" | "down" | "flat";
  confidence: number;
  source: string;
}

export interface Trade {
  id: string;
  epic: string;
  side: TradeSide;
  openedAt: number;
  entry: number;
  /** Units of the contract */
  size: number;
  stop?: number;
  target?: number;
  /** What the forecast said when the trade was logged */
  model?: TradeModel | null;
  note?: string;
  closedAt?: number;
  exit?: number;
  /** Opened from the dashboard (or found on the demo account): the Capital.com deal this trade follows */
  dealId?: string;
  demo?: boolean;
  /** Stop after it was moved (the original `stop` stays the basis of the result in R) */
  stopMoved?: number;
  /** When the position was seen gone from the account without its closing price: the exit has to be entered by hand */
  brokerClosed?: number;
}

export const MAX_TRADES = 2000;
const NOTE_MAX = 500;

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const optPos = (v: unknown) => v === undefined || v === null || pos(v);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseNewTrade(body: unknown, validEpics: string[], now = Date.now()): Parsed<Omit<Trade, "id">> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.epic !== "string" || !validEpics.includes(b.epic)) return { ok: false, error: "Instrument inconnu." };
  if (b.side !== "long" && b.side !== "short") return { ok: false, error: "Sens invalide." };
  if (!pos(b.entry)) return { ok: false, error: "Prix d'entrée invalide." };
  if (!pos(b.size)) return { ok: false, error: "Taille invalide." };
  if (!optPos(b.stop) || !optPos(b.target)) return { ok: false, error: "Stop ou objectif invalide." };
  const stop = b.stop as number | undefined | null;
  const target = b.target as number | undefined | null;
  // a stop must protect, a target must reward
  if (stop != null && (b.side === "long" ? stop >= b.entry : stop <= b.entry)) return { ok: false, error: "Le stop doit être du bon côté du prix d'entrée." };
  if (target != null && (b.side === "long" ? target <= b.entry : target >= b.entry)) return { ok: false, error: "L'objectif doit être du bon côté du prix d'entrée." };
  const openedAt = b.openedAt === undefined ? now : b.openedAt;
  if (typeof openedAt !== "number" || !Number.isFinite(openedAt) || openedAt <= 0 || openedAt > now + 60_000) return { ok: false, error: "Date d'ouverture invalide." };
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > NOTE_MAX)) return { ok: false, error: `Note trop longue (${NOTE_MAX} caractères maximum).` };

  let model: TradeModel | null = null;
  const m = b.model as Record<string, unknown> | null | undefined;
  if (m) {
    if (!["up", "down", "flat"].includes(m.direction as string) || typeof m.confidence !== "number" || typeof m.source !== "string") {
      return { ok: false, error: "Prévision du modèle invalide." };
    }
    model = { direction: m.direction as TradeModel["direction"], confidence: m.confidence, source: m.source.slice(0, 80) };
  }
  return {
    ok: true,
    value: {
      epic: b.epic,
      side: b.side,
      openedAt,
      entry: b.entry,
      size: b.size,
      ...(stop != null ? { stop } : {}),
      ...(target != null ? { target } : {}),
      model,
      ...(typeof b.note === "string" && b.note ? { note: b.note } : {}),
    },
  };
}

export interface TradePatch {
  exit?: number;
  closedAt?: number;
  stop?: number | null;
  target?: number | null;
  note?: string;
}

export function parsePatch(body: unknown, now = Date.now()): Parsed<TradePatch> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: TradePatch = {};
  if (b.exit !== undefined) {
    if (!pos(b.exit)) return { ok: false, error: "Prix de sortie invalide." };
    out.exit = b.exit;
  }
  if (b.closedAt !== undefined) {
    if (typeof b.closedAt !== "number" || !Number.isFinite(b.closedAt) || b.closedAt <= 0 || b.closedAt > now + 60_000) return { ok: false, error: "Date de clôture invalide." };
    out.closedAt = b.closedAt;
  }
  for (const k of ["stop", "target"] as const) {
    if (b[k] !== undefined) {
      if (b[k] !== null && !pos(b[k])) return { ok: false, error: `${k === "stop" ? "Stop" : "Objectif"} invalide.` };
      out[k] = b[k] as number | null;
    }
  }
  if (b.note !== undefined) {
    if (typeof b.note !== "string" || b.note.length > NOTE_MAX) return { ok: false, error: `Note trop longue (${NOTE_MAX} caractères maximum).` };
    out.note = b.note;
  }
  return Object.keys(out).length ? { ok: true, value: out } : { ok: false, error: "Rien à modifier." };
}

/** Applies a patch; closing a trade needs an exit price. Returns an error string for inconsistent results. */
export function applyPatch(t: Trade, p: TradePatch, now = Date.now()): Trade | string {
  const next: Trade = { ...t };
  if (p.exit !== undefined) {
    next.exit = p.exit;
    next.closedAt = p.closedAt ?? now;
  } else if (p.closedAt !== undefined) {
    if (t.exit === undefined) return "Une date de clôture demande un prix de sortie.";
    next.closedAt = p.closedAt;
  }
  if (next.closedAt !== undefined && next.closedAt < t.openedAt) return "La clôture ne peut pas précéder l'ouverture.";
  if (p.stop !== undefined) {
    if (p.stop === null) delete next.stop;
    else if (t.side === "long" ? p.stop >= t.entry : p.stop <= t.entry) return "Le stop doit être du bon côté du prix d'entrée.";
    else next.stop = p.stop;
  }
  if (p.target !== undefined) {
    if (p.target === null) delete next.target;
    else if (t.side === "long" ? p.target <= t.entry : p.target >= t.entry) return "L'objectif doit être du bon côté du prix d'entrée.";
    else next.target = p.target;
  }
  if (p.note !== undefined) {
    if (p.note) next.note = p.note;
    else delete next.note;
  }
  return next;
}

// --------------------------------------------------------------------------- statistics

export const isClosed = (t: Trade): t is Trade & { exit: number; closedAt: number } => t.exit !== undefined && t.closedAt !== undefined;
const dir = (t: Trade) => (t.side === "long" ? 1 : -1);

/** Profit or loss in the quote currency, before financing costs. */
export function tradePnl(t: Trade): number | null {
  return isClosed(t) ? dir(t) * (t.exit - t.entry) * t.size : null;
}

/** Result in R: profit or loss divided by the amount risked at the stop. */
export function tradeR(t: Trade): number | null {
  const pnl = tradePnl(t);
  if (pnl === null || t.stop === undefined) return null;
  const risk = Math.abs(t.entry - t.stop) * t.size;
  return risk > 0 ? pnl / risk : null;
}

const agrees = (t: Trade) => (t.model?.direction === "up" && t.side === "long") || (t.model?.direction === "down" && t.side === "short");

export interface Group {
  trades: number;
  wins: number;
  pnl: number;
}

export interface TradeStats {
  open: number;
  closed: number;
  wins: number;
  /** null below 20 closed trades */
  winRate: number | null;
  margin: number | null;
  totalPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  /** Mean result in R over closed trades that had a stop */
  expectancyR: number | null;
  withStop: number;
  noStop: number;
  maxDrawdown: number;
  /** Profit or loss of the trades closed since `dayStart` */
  todayPnl: number;
  curve: Array<{ t: number; v: number }>;
  withModel: Group;
  againstModel: Group;
}

export function tradeStats(trades: Trade[], dayStart: number): TradeStats {
  const closed = trades.filter(isClosed).sort((a, b) => a.closedAt - b.closedAt);
  let total = 0, grossWin = 0, grossLoss = 0, wins = 0, losses = 0, peak = 0, maxDd = 0, today = 0;
  const curve: TradeStats["curve"] = [];
  const rs: number[] = [];
  const withModel: Group = { trades: 0, wins: 0, pnl: 0 };
  const againstModel: Group = { trades: 0, wins: 0, pnl: 0 };

  for (const t of closed) {
    const pnl = tradePnl(t)!;
    total += pnl;
    if (pnl > 0) {
      wins++;
      grossWin += pnl;
    } else if (pnl < 0) {
      losses++;
      grossLoss += -pnl;
    }
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, peak - total);
    if (t.closedAt >= dayStart) today += pnl;
    curve.push({ t: t.closedAt, v: total });
    const r = tradeR(t);
    if (r !== null) rs.push(r);
    if (t.model && t.model.direction !== "flat") {
      const g = agrees(t) ? withModel : againstModel;
      g.trades++;
      g.wins += pnl > 0 ? 1 : 0;
      g.pnl += pnl;
    }
  }
  const n = closed.length;
  return {
    open: trades.length - n,
    closed: n,
    wins,
    winRate: n >= 20 ? wins / n : null,
    margin: n >= 20 ? (1.96 * 0.5) / Math.sqrt(n) : null,
    totalPnl: total,
    avgWin: wins ? grossWin / wins : null,
    avgLoss: losses ? -grossLoss / losses : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    withStop: closed.filter((t) => t.stop !== undefined).length,
    noStop: closed.filter((t) => t.stop === undefined).length,
    maxDrawdown: maxDd,
    todayPnl: today,
    curve,
    withModel,
    againstModel,
  };
}
