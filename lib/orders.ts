import "server-only";
import { INSTRUMENTS } from "@/config/instruments";
import type { Trade, TradeModel } from "./trades";
import { readTrades, updateTrades } from "./trades-store";
import { hmacHex, timingSafeEqualStr } from "./auth";
import {
  amendPositionStop,
  assertDemoOnly,
  capitalEnv,
  CapitalError,
  closePositionDeal,
  getCloseInfo,
  getConfirmation,
  getFreshQuote,
  listPositions,
  openPosition,
  type DealConfirmation,
  type OpenPosition,
} from "./capital";

// Orders on the DEMO account, never automatic: the server checks the order, shows a recap, and only sends it when the
// browser comes back with the signed recap. Everything here is refused unless TRADING_ENABLED=true and the account is demo.

export const LIMITS = {
  maxOpenPositions: 3,
  /** Size x price, in the quote currency */
  maxNotionalUsd: 25_000,
  minSize: 0.01,
  maxSize: 100_000,
  /** The same instrument and direction opened again within this delay is refused (double click, replay) */
  duplicateWindowMs: 120_000,
  /** The recap must be confirmed within this delay */
  tokenTtlMs: 120_000,
  /** Stop distance, % of the price: tighter than the noise or wider than a sane stop is refused */
  stopMinPct: 0.02,
  stopMaxPct: 15,
  /** The price may drift this much (%) between the recap and the sending */
  maxDriftPct: 0.25,
} as const;

export const tradingEnabled = () => process.env.TRADING_ENABLED === "true";

export interface Order {
  epic: string;
  side: "long" | "short";
  size: number;
  stop: number;
  target: number | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function parseOrder(body: unknown, epics: string[] = INSTRUMENTS.map((i) => i.epic)): Parsed<Order> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.epic !== "string" || !epics.includes(b.epic)) return { ok: false, error: "Instrument non configuré." };
  if (b.side !== "long" && b.side !== "short") return { ok: false, error: "Sens invalide (achat ou vente)." };
  const size = num(b.size);
  if (size === null || size < LIMITS.minSize || size > LIMITS.maxSize) return { ok: false, error: `Taille invalide (de ${LIMITS.minSize} à ${LIMITS.maxSize}).` };
  const stop = num(b.stop);
  if (stop === null || stop <= 0) return { ok: false, error: "Le stop est obligatoire (niveau de prix)." };
  const target = b.target === undefined || b.target === null || b.target === "" ? null : num(b.target);
  if (target !== null && target <= 0) return { ok: false, error: "Objectif invalide (niveau de prix)." };
  if (b.target !== undefined && b.target !== null && b.target !== "" && target === null) return { ok: false, error: "Objectif invalide (niveau de prix)." };
  return { ok: true, value: { epic: b.epic, side: b.side, size: round(size, 2), stop: round(stop, 6), target: target === null ? null : round(target, 6) } };
}

export interface Plan {
  /** Price the order would be filled at, now (offer for a buy, bid for a sell) */
  entry: number;
  notional: number;
  /** Loss if the stop is hit, in the quote currency */
  risk: number;
  reward: number | null;
  ratio: number | null;
  spread: number;
  warnings: string[];
}

export interface QuoteLike {
  status: string;
  bid: number | null;
  offer: number | null;
}

/** All the checks that do not need the network: the same ones are run at the recap and again just before sending. */
export function assessOrder(order: Order, quote: QuoteLike, positions: OpenPosition[], now: number): Parsed<Plan> {
  if (quote.status !== "TRADEABLE") return { ok: false, error: "Le marché n'est pas ouvert à la négociation pour l'instant." };
  if (quote.bid === null || quote.offer === null || quote.offer < quote.bid) return { ok: false, error: "Pas de cotation exploitable pour cet instrument." };
  const long = order.side === "long";
  const entry = long ? quote.offer : quote.bid;
  const spread = quote.offer - quote.bid;

  if (long ? order.stop >= entry : order.stop <= entry) return { ok: false, error: `Pour ${long ? "un achat" : "une vente"}, le stop doit être ${long ? "sous" : "au-dessus de"} le prix actuel (${entry}).` };
  if (order.target !== null && (long ? order.target <= entry : order.target >= entry)) {
    return { ok: false, error: `Pour ${long ? "un achat" : "une vente"}, l'objectif doit être ${long ? "au-dessus de" : "sous"} le prix actuel (${entry}).` };
  }
  const stopDist = Math.abs(entry - order.stop);
  const stopPct = (stopDist / entry) * 100;
  if (stopPct > LIMITS.stopMaxPct) return { ok: false, error: `Stop trop éloigné (${stopPct.toFixed(1)} % du prix, maximum ${LIMITS.stopMaxPct} %).` };
  if (stopPct < LIMITS.stopMinPct || stopDist < 2 * spread) return { ok: false, error: "Stop trop proche du prix : il serait touché par le simple écart entre achat et vente." };

  const notional = order.size * entry;
  if (notional > LIMITS.maxNotionalUsd) return { ok: false, error: `Position trop grosse (${Math.round(notional).toLocaleString("fr-FR")} $, maximum ${LIMITS.maxNotionalUsd.toLocaleString("fr-FR")} $).` };

  if (positions.length >= LIMITS.maxOpenPositions) return { ok: false, error: `Déjà ${positions.length} positions ouvertes (maximum ${LIMITS.maxOpenPositions}) : fermez-en une d'abord.` };
  const dir = long ? "BUY" : "SELL";
  if (positions.some((p) => p.epic === order.epic && p.direction === dir && p.createdAt !== null && now - p.createdAt < LIMITS.duplicateWindowMs)) {
    return { ok: false, error: "Une position identique vient d'être ouverte : ordre refusé pour éviter un doublon." };
  }

  const risk = order.size * stopDist;
  const reward = order.target === null ? null : order.size * Math.abs(order.target - entry);
  const ratio = reward === null || risk === 0 ? null : reward / risk;
  const warnings: string[] = [];
  if (order.target === null) warnings.push("Pas d'objectif : la position ne se fermera que sur le stop ou à la main.");
  if (ratio !== null && ratio < 1) warnings.push("L'objectif est plus proche que le stop : il faut gagner plus d'une fois sur deux pour s'en sortir.");
  if (spread > 0.2 * stopDist) warnings.push("Le spread représente plus de 20 % de la distance du stop : coût élevé.");
  return { ok: true, value: { entry, notional, risk, reward, ratio, spread, warnings } };
}

// ---------------------------------------------------------------------------
// Signed recap

interface TokenPayload {
  o: Order;
  /** Price at the recap */
  e: number;
  /** Expiry (ms) */
  x: number;
  /** One use per instance */
  n: string;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function signingKey(): string {
  const key = process.env.DASHBOARD_PASSWORD;
  if (!key) throw new CapitalError("TRADING_REFUSED", "Mot de passe du site non défini : ordres refusés.", 403);
  return key;
}

export async function signRecap(payload: TokenPayload): Promise<string> {
  const body = b64(JSON.stringify(payload));
  return `${body}.${await hmacHex(signingKey(), `order/v1/${body}`)}`;
}

export async function readRecap(token: unknown, now: number): Promise<TokenPayload | null> {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmacHex(signingKey(), `order/v1/${body}`);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const p = JSON.parse(unb64(body)) as TokenPayload;
    return p.x > now ? p : null;
  } catch {
    return null;
  }
}

const usedNonces = new Set<string>();
export function __resetOrders() {
  usedNonces.clear();
  confirmWaitMs = 400;
}
let confirmWaitMs = 400;
export function __setConfirmWait(ms: number) {
  confirmWaitMs = ms;
}

// ---------------------------------------------------------------------------
// Service

function gate() {
  if (!tradingEnabled()) {
    throw new CapitalError("TRADING_REFUSED", "Les ordres sont désactivés : ajoutez TRADING_ENABLED=true (compte démo) dans les variables du serveur, puis redéployez.", 403);
  }
  assertDemoOnly();
}

export interface OrdersState {
  enabled: boolean;
  /** Why the panel is off */
  reason?: "off" | "live";
  limits: typeof LIMITS;
  positions?: OpenPosition[];
  positionsError?: string;
}

export async function ordersState(): Promise<OrdersState> {
  if (capitalEnv() !== "demo") return { enabled: false, reason: "live", limits: LIMITS };
  if (!tradingEnabled()) return { enabled: false, reason: "off", limits: LIMITS };
  try {
    const positions = await listPositions();
    // Keeps "Mes trades" in line with the account (closed by a stop or a target, stop moved, opened elsewhere); never fails the panel
    await syncDemoTrades(Date.now(), positions).catch((err) => console.warn("[orders] sync failed:", err instanceof Error ? err.message : "unknown"));
    return { enabled: true, limits: LIMITS, positions };
  } catch (err) {
    return { enabled: true, limits: LIMITS, positionsError: err instanceof CapitalError ? err.message : "Positions illisibles." };
  }
}

export interface Recap {
  order: Order;
  plan: Plan;
  token: string;
  expiresAt: number;
}

export async function previewOrder(body: unknown, now = Date.now()): Promise<Recap> {
  gate();
  const parsed = parseOrder(body);
  if (!parsed.ok) throw new CapitalError("TRADING_REFUSED", parsed.error, 400);
  const [quote, positions] = await Promise.all([getFreshQuote(parsed.value.epic), listPositions()]);
  const plan = assessOrder(parsed.value, quote, positions, now);
  if (!plan.ok) throw new CapitalError("TRADING_REFUSED", plan.error, 422);
  const expiresAt = now + LIMITS.tokenTtlMs;
  const token = await signRecap({ o: parsed.value, e: plan.value.entry, x: expiresAt, n: crypto.randomUUID() });
  return { order: parsed.value, plan: plan.value, token, expiresAt };
}

export interface DealResult {
  status: "accepted" | "rejected" | "unknown";
  reason: string | null;
  dealId: string | null;
  level: number | null;
  dealReference: string;
  /** The accepted order was written into "Mes trades" */
  logged?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The broker answers a moment after the request: ask a few times, and say "unknown" rather than guess. */
async function confirm(dealReference: string): Promise<DealResult> {
  let c: DealConfirmation | null = null;
  for (let i = 0; i < 4 && !c; i++) {
    try {
      c = await getConfirmation(dealReference);
    } catch {
      await sleep(confirmWaitMs);
    }
  }
  if (!c) return { status: "unknown", reason: "Confirmation non lue : vérifiez la liste des positions.", dealId: null, level: null, dealReference };
  return { status: c.accepted ? "accepted" : "rejected", reason: c.reason, dealId: c.dealId, level: c.level, dealReference };
}

/** What the forecast said when the order was sent; kept with the trade so that the result can be compared with it. */
export function parseModel(raw: unknown): TradeModel | null {
  const m = raw as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== "object") return null;
  if (!["up", "down", "flat"].includes(m.direction as string) || typeof m.confidence !== "number" || !Number.isFinite(m.confidence) || typeof m.source !== "string") return null;
  return { direction: m.direction as TradeModel["direction"], confidence: m.confidence, source: m.source.slice(0, 80) };
}

export async function placeOrder(token: unknown, model: unknown = null, now = Date.now()): Promise<DealResult & { order: Order }> {
  gate();
  const recap = await readRecap(token, now);
  if (!recap) throw new CapitalError("TRADING_REFUSED", "Confirmation expirée ou invalide : vérifiez l'ordre de nouveau.", 400);
  if (usedNonces.has(recap.n)) throw new CapitalError("TRADING_REFUSED", "Cet ordre a déjà été envoyé.", 409);

  const [quote, positions] = await Promise.all([getFreshQuote(recap.o.epic), listPositions()]);
  const plan = assessOrder(recap.o, quote, positions, now);
  if (!plan.ok) throw new CapitalError("TRADING_REFUSED", plan.error, 422);
  const drift = (Math.abs(plan.value.entry - recap.e) / recap.e) * 100;
  if (drift > LIMITS.maxDriftPct) {
    throw new CapitalError("TRADING_REFUSED", `Le prix a bougé de ${drift.toFixed(2)} % depuis la vérification : vérifiez l'ordre de nouveau.`, 409);
  }

  usedNonces.add(recap.n);
  const ref = await openPosition({
    epic: recap.o.epic,
    direction: recap.o.side === "long" ? "BUY" : "SELL",
    size: recap.o.size,
    stopLevel: recap.o.stop,
    ...(recap.o.target !== null ? { profitLevel: recap.o.target } : {}),
  });
  console.info(`[orders] demo order sent: ${recap.o.epic} ${recap.o.side} size=${recap.o.size}`);
  const result = await confirm(ref);
  let logged = false;
  if (result.status === "accepted" && result.dealId && result.level !== null) {
    // The broker has the order whatever happens here: a failure to write the trade is reported, and the next sync adopts the position
    logged = await logDemoTrade(recap.o, result.dealId, result.level, parseModel(model), now).then(() => true, () => false);
  }
  return { ...result, logged, order: recap.o };
}

async function logDemoTrade(order: Order, dealId: string, level: number, model: TradeModel | null, now: number): Promise<void> {
  await updateTrades<null>((trades) => {
    if (trades.some((t) => t.dealId === dealId)) return { trades, result: null };
    const trade: Trade = {
      id: crypto.randomUUID(),
      epic: order.epic,
      side: order.side,
      openedAt: now,
      entry: level,
      size: order.size,
      stop: order.stop,
      ...(order.target !== null ? { target: order.target } : {}),
      model,
      note: "Ordre passé depuis le dashboard (compte démo).",
      dealId,
      demo: true,
    };
    return { trades: [...trades, trade], result: null };
  });
}

async function patchTrade(dealId: string, fn: (t: Trade) => Trade): Promise<boolean> {
  return updateTrades<boolean>((trades) => {
    const i = trades.findIndex((t) => t.dealId === dealId);
    if (i < 0) return { trades, result: false };
    const copy = [...trades];
    copy[i] = fn(trades[i]);
    return { trades: copy, result: true };
  });
}

export async function closeOrder(dealId: string): Promise<DealResult> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dealId)) throw new CapitalError("TRADING_REFUSED", "Identifiant de position invalide.", 400);
  // Closing is allowed even when new orders are switched off: flattening is always the safe direction. Demo only.
  assertDemoOnly();
  const ref = await closePositionDeal(dealId);
  console.info("[orders] demo position closed");
  const result = await confirm(ref);
  if (result.status === "accepted" && result.level !== null) {
    const exit = result.level;
    // The price Capital.com confirmed is the exact exit; without it the sync looks it up in the account activity
    await patchTrade(dealId, (t) => (t.exit === undefined ? { ...t, exit, closedAt: Date.now() } : t)).catch(() => false);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Moving a stop

export interface StopMoveInput {
  side: "long" | "short";
  /** Current stop of the position, if any */
  currentStop: number | null;
  newStop: number;
}

/** A stop only ever moves closer to the price (never away: that would be taking back the protection), and stays clear of the spread. */
export function assessStopMove(i: StopMoveInput, quote: QuoteLike): Parsed<null> {
  if (quote.status !== "TRADEABLE") return { ok: false, error: "Le marché n'est pas ouvert à la négociation pour l'instant." };
  if (quote.bid === null || quote.offer === null || quote.offer < quote.bid) return { ok: false, error: "Pas de cotation exploitable pour cet instrument." };
  if (!Number.isFinite(i.newStop) || i.newStop <= 0) return { ok: false, error: "Niveau de stop invalide." };
  const spread = quote.offer - quote.bid;
  if (i.side === "long") {
    if (i.newStop >= quote.bid - spread) return { ok: false, error: `Le stop doit rester sous le prix actuel (${quote.bid}), avec au moins l'écart achat/vente de marge.` };
    if (i.currentStop !== null && i.newStop <= i.currentStop) return { ok: false, error: `Le stop ne peut que se resserrer : il est déjà à ${i.currentStop}.` };
  } else {
    if (i.newStop <= quote.offer + spread) return { ok: false, error: `Le stop doit rester au-dessus du prix actuel (${quote.offer}), avec au moins l'écart achat/vente de marge.` };
    if (i.currentStop !== null && i.newStop >= i.currentStop) return { ok: false, error: `Le stop ne peut que se resserrer : il est déjà à ${i.currentStop}.` };
  }
  return { ok: true, value: null };
}

export async function moveStop(dealId: string, newStop: unknown): Promise<DealResult & { stop: number }> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dealId)) throw new CapitalError("TRADING_REFUSED", "Identifiant de position invalide.", 400);
  // Protective, so allowed even when new orders are switched off. Demo only.
  assertDemoOnly();
  if (typeof newStop !== "number" || !Number.isFinite(newStop)) throw new CapitalError("TRADING_REFUSED", "Niveau de stop invalide.", 400);
  const positions = await listPositions();
  const p = positions.find((x) => x.dealId === dealId);
  if (!p) throw new CapitalError("TRADING_REFUSED", "Position introuvable : elle est peut-être déjà fermée.", 404);
  const quote = await getFreshQuote(p.epic);
  const check = assessStopMove({ side: p.direction === "BUY" ? "long" : "short", currentStop: p.stopLevel, newStop }, quote);
  if (!check.ok) throw new CapitalError("TRADING_REFUSED", check.error, 422);
  const ref = await amendPositionStop(dealId, newStop, p.profitLevel);
  console.info("[orders] demo stop moved");
  const result = await confirm(ref);
  if (result.status === "accepted") await patchTrade(dealId, (t) => ({ ...t, stopMoved: newStop })).catch(() => false);
  return { ...result, stop: newStop };
}

// ---------------------------------------------------------------------------
// Keeping "Mes trades" in line with the demo account

/**
 * Compares the open positions of the demo account with the trades that follow a deal:
 * - a position nobody noted (opened on Capital.com itself, or whose trade could not be written) is added;
 * - a trade whose position is gone is closed at the price the account activity gives (stop or target hit, or closed
 *   elsewhere); without that price the trade is only flagged, so that the exit is entered by hand and never guessed;
 * - a stop moved elsewhere is picked up.
 */
export async function syncDemoTrades(now = Date.now(), known?: OpenPosition[]): Promise<number> {
  assertDemoOnly();
  const positions = known ?? (await listPositions());
  const trades = await readTrades();
  if (trades === null) return 0;
  const epics = new Set(INSTRUMENTS.map((i) => i.epic));
  const byDeal = new Map(trades.filter((t) => t.dealId).map((t) => [t.dealId as string, t] as const));
  const open = new Set(positions.map((p) => p.dealId));

  const adopt = positions.filter((p) => !byDeal.has(p.dealId) && epics.has(p.epic));
  const gone = trades.filter((t) => t.dealId && t.exit === undefined && !open.has(t.dealId));
  const closes = new Map<string, { level: number; at: number | null } | null>();
  for (const t of gone) closes.set(t.dealId as string, await getCloseInfo(t.dealId as string, t.openedAt).catch(() => null));

  const moves = new Map<string, number>();
  for (const p of positions) {
    const t = byDeal.get(p.dealId);
    if (t && t.exit === undefined && p.stopLevel !== null && p.stopLevel !== (t.stopMoved ?? t.stop)) moves.set(p.dealId, p.stopLevel);
  }
  if (!adopt.length && !gone.length && !moves.size) return 0;

  let changed = 0;
  await updateTrades<null>((current) => {
    changed = 0;
    const next = current.map((t) => {
      const id = t.dealId;
      if (!id || t.exit !== undefined) return t;
      if (!open.has(id)) {
        const c = closes.get(id);
        if (c) {
          changed++;
          return { ...t, exit: c.level, closedAt: Math.max(t.openedAt, c.at ?? now) };
        }
        if (t.brokerClosed === undefined) {
          changed++;
          return { ...t, brokerClosed: now };
        }
        return t;
      }
      const m = moves.get(id);
      if (m !== undefined) {
        changed++;
        return t.stop !== undefined && m === t.stop ? t : { ...t, stopMoved: m };
      }
      return t;
    });
    const have = new Set(next.map((t) => t.dealId).filter(Boolean));
    for (const p of adopt) {
      if (have.has(p.dealId)) continue;
      const long = p.direction === "BUY";
      const protective = p.stopLevel !== null && (long ? p.stopLevel < p.level : p.stopLevel > p.level);
      changed++;
      next.push({
        id: crypto.randomUUID(),
        epic: p.epic,
        side: long ? "long" : "short",
        openedAt: p.createdAt ?? now,
        entry: p.level,
        size: p.size,
        ...(protective ? { stop: p.stopLevel as number } : p.stopLevel !== null ? { stopMoved: p.stopLevel } : {}),
        ...(p.profitLevel !== null && (long ? p.profitLevel > p.level : p.profitLevel < p.level) ? { target: p.profitLevel } : {}),
        model: null,
        note: "Position du compte démo reprise automatiquement.",
        dealId: p.dealId,
        demo: true,
      });
    }
    return { trades: next, result: null };
  });
  return changed;
}
