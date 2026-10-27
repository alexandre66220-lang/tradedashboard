import "server-only";
import { INSTRUMENTS, OUTLOOKS, type Instrument } from "@/config/instruments";
import { CapitalError, getCandles } from "@/lib/capital";
import { runForecast } from "@/lib/forecast";
import { recordSafe } from "@/lib/journal/service";
import { readList, updateList } from "@/lib/store";
import { OUTLOOK_PENDING, type OutlookCell, type OutlookItem, type OutlookResponse } from "@/lib/types";

type Outlook = (typeof OUTLOOKS)[number];

// Daily / weekly forecasts change slowly: one is kept for half an hour, in the shared store, so that any server instance
// can serve it. Computing one takes a model run; a request never waits for more than BUDGET_MS for the missing ones.
export const CELL_TTL_MS = 30 * 60_000;
export const BUDGET_MS = 20_000;
const CANDLES_TTL_MS = 5 * 60_000;

interface Stored {
  at: number;
  last: number | null;
  source?: string;
  cell: OutlookCell;
}

const storeKey = (epic: string, key: string) => `cache/outlook/${epic}__${key}.json`;
const inflight = new Map<string, Promise<Stored>>();

export function __resetOutlook() {
  inflight.clear();
}

function message(err: unknown): string {
  return err instanceof CapitalError ? err.message : "Prévision indisponible.";
}

async function readFresh(inst: Instrument, o: Outlook, now: number): Promise<Stored | null> {
  const stored = (await readList<Stored>(storeKey(inst.epic, o.key)).catch(() => null))?.[0];
  return stored && now - stored.at < CELL_TTL_MS ? stored : null;
}

async function compute(inst: Instrument, o: Outlook): Promise<Stored> {
  const candles = await getCandles(inst.epic, o.api, 1000, CANDLES_TTL_MS);
  const last = candles.at(-1);
  if (!last) throw new CapitalError("NO_DATA", "Pas d'historique disponible.");
  const f = await runForecast({ epic: inst.epic, resolution: o.api, resolutionMinutes: o.minutes, horizon: o.minutes, candles });
  const end = f.points.at(-1);
  if (!end || ![end.value, end.low, end.high, f.confidence].every(Number.isFinite)) {
    throw new CapitalError("NO_DATA", "Historique insuffisant pour cette prévision.");
  }
  await recordSafe({ epic: inst.epic, resolution: o.api, resMinutes: o.minutes, horizon: o.minutes }, candles, f);
  return {
    at: Date.now(),
    last: last.close,
    source: f.source,
    cell: {
      change: end.value / last.close - 1,
      target: end.value,
      low: end.low,
      high: end.high,
      direction: f.direction,
      confidence: f.confidence,
      backtestHitRate: f.backtestHitRate,
      backtestSamples: f.backtestSamples,
      backtest: f.backtest,
    },
  };
}

/** The stored forecast if it is fresh, else a computed one (stored for the next request). Shared by simultaneous callers. */
function ensure(inst: Instrument, o: Outlook): Promise<Stored> {
  const k = `${inst.epic}|${o.key}`;
  const running = inflight.get(k);
  if (running) return running;
  const p = (async () => {
    const fresh = await readFresh(inst, o, Date.now());
    if (fresh) return fresh;
    const s = await compute(inst, o);
    await updateList<Stored, void>(storeKey(inst.epic, o.key), () => ({ items: [s], result: undefined })).catch(() => {});
    return s;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/**
 * Outlook of every instrument. Forecasts that are not ready within `budgetMs` are reported as pending (and keep
 * being computed if the server stays alive); asking again a few seconds later finds them in the store.
 */
export async function buildOutlook(budgetMs = BUDGET_MS): Promise<OutlookResponse> {
  let source: string | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), budgetMs)));

  const items = await Promise.all(
    INSTRUMENTS.map(async (inst): Promise<OutlookItem> => {
      const item: OutlookItem = { epic: inst.epic, name: inst.name, last: null, horizons: {} };
      await Promise.all(
        OUTLOOKS.map(async (o) => {
          try {
            const got = await Promise.race([ensure(inst, o), deadline]);
            if (got === "late") {
              pending = true;
              item.horizons[o.key] = { error: OUTLOOK_PENDING };
              return;
            }
            source ??= got.source;
            if (o.key === "day") item.last = got.last;
            item.horizons[o.key] = got.cell;
          } catch (err) {
            item.horizons[o.key] = { error: message(err) };
          }
        }),
      );
      return item;
    }),
  );
  clearTimeout(timer);
  return { items, source, generatedAt: Date.now(), ...(pending ? { pending: true } : {}) };
}

// ---- one forecast at a time -----------------------------------------------------------------------------------
// A serverless host stops a function as soon as its response is sent, so work left running "in the background" never
// finishes. The browser therefore asks for each missing forecast in its own request (which waits for the result), and
// the overview only reads what is already stored.

export function findOutlook(epic: string, key: string): { inst: Instrument; o: Outlook } | null {
  const inst = INSTRUMENTS.find((i) => i.epic === epic);
  const o = OUTLOOKS.find((x) => x.key === key);
  return inst && o ? { inst, o } : null;
}

/** The forecast of one instrument and one outlook: from the store when fresh, else computed (and stored). */
export function computeCell(inst: Instrument, o: Outlook): Promise<Stored> {
  return ensure(inst, o);
}

/** The outlook from what is stored, without computing anything: cells that are missing or expired are pending. */
export async function readStored(): Promise<OutlookResponse> {
  const now = Date.now();
  let source: string | undefined;
  let pending = false;
  const items = await Promise.all(
    INSTRUMENTS.map(async (inst): Promise<OutlookItem> => {
      const item: OutlookItem = { epic: inst.epic, name: inst.name, last: null, horizons: {} };
      await Promise.all(
        OUTLOOKS.map(async (o) => {
          const got = await readFresh(inst, o, now);
          if (!got) {
            pending = true;
            item.horizons[o.key] = { error: OUTLOOK_PENDING };
            return;
          }
          source ??= got.source;
          if (o.key === "day") item.last = got.last;
          item.horizons[o.key] = got.cell;
        }),
      );
      return item;
    }),
  );
  return { items, source, generatedAt: now, ...(pending ? { pending: true } : {}) };
}
