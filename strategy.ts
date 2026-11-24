// Patient Sniper: small-stakes momentum on pump.fun bonding curves (agent-fun/replay/v2).
//
// Written from scratch for this bounty. Shape of the edge on this data:
//   - Almost every new curve goes to zero. Buying early = catching the dump.
//   - A few curves run hard. The win comes from many small bets, cutting losers
//     fast, and letting the rare runner pay for the losers.
//   - Fees are ~1.25% per direction plus ~0.000105 SOL tx fee per order, so a
//     round trip on a small stake needs a real move to break even. Stakes stay
//     small, stops stay tight, and take-profit is taken in full on strength.
//
// Entry: a curve becomes a buy only when it is mature (past minAge slots since
// its CreateEvent), holds real SOL in [minRqSol, maxRqSol], and its recent tape
// shows accelerating buy pressure: net SOL in, several distinct buyers, price
// up but not overextended, price near its window high, newer-half inflow at
// least accel x the older half, and no single wallet dominating buys.
//
// Sizing: first buy is small (initialSol). The position is pyramided into
// strength only, up to stakeSol, while the price holds above the last buy and
// inflow continues. False starts cost little; runners get size.
//
// Exits (whole position): stop loss vs cost, trailing stop from peak value
// once armed, take-profit, max hold, fade on net outflow, big-sell exit, and
// an immediate exit when the curve's creator sells.
//
// Guardrail pacing: the run must end with round trips on at least 20 distinct
// mints (>= 0.01 SOL each). If the coin count lags the pace milestones (slots
// since the first batch), the bot opens tiny probe round trips on liquid
// curves until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far in one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Take profit when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Guardrail pacing: coins with a round trip by slot-offset milestones. */
  paceMilestones: number[];
  paceCoins: number[];
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 90,
  minNetSol: 0.2,
  minBuys: 3,
  minBuyers: 2,
  minPriceUp: 0.01,
  maxPriceUp: 1.2,
  accel: 1,
  nearHigh: 0.85,
  maxBuyerShare: 0.7,
  minRqSol: 2,
  maxRqSol: 80,
  minAge: 900,
  stakeSol: 0.25,
  minBuySol: 0.01,
  buySlipBps: 1200,
  stopLoss: 0.06,
  trail: 0.25,
  trailArm: 0.1,
  takeProfit: 1.0,
  fadeWindow: 15,
  fadeNetSol: 0.5,
  bigSellSol: 2,
  maxHold: 1200,
  holdIfUp: 0.25,
  cooldown: 120,
  maxEntries: 2,
  initialSol: 0.05,
  addSol: 0.1,
  addStep: 0.02,
  addIfUp: 0.05,
  addNetSol: 0.5,
  maxMain: 5,
  paceMilestones: [15000, 30000, 45000, 60000, 75000, 90000],
  paceCoins: [4, 8, 12, 16, 19, 22],
  probeSol: 0.01,
  maxProbes: 4,
  maxExposureSol: 1.5,
};

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Close value of holding `tokens` on a curve, in SOL, after curve + tx fees. */
function closeValue(tokens: bigint, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  const t = tokens;
  const vt = curve.virtual_token_reserves;
  const vq = curve.virtual_quote_reserves;
  if (t === 0n || vt + t === 0n) return 0;
  const out = (t * vq) / (vt + t);
  const net = Number(out) / LAMPORTS;
  return net * (1 - 0.0125) - 0.000105;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins with at least one filled buy (any kind). */
  const coinsTraded = new Set<Pubkey>();
  /** Slot of the first batch seen; pacing is measured from here. */
  let firstSlot = -1;
  let probeCount = 0;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, lastExit: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Net SOL over the tape slice (buys positive, sells negative). */
  function netSol(trades: Trade[]): number {
    let n = 0;
    for (const t of trades) n += t.buy ? t.sol : -t.sol;
    return n;
  }

  function signal(mint: Pubkey, curve: { real_quote_reserves: bigint; virtual_quote_reserves: bigint; virtual_token_reserves: bigint }, now: number): boolean {
    const t = tapes.get(mint);
    if (t === undefined || t.created === null) return false;
    if (now - t.created < p.minAge) return false;
    if (t.entries >= p.maxEntries) return false;
    if (t.lastExit >= 0 && now - t.lastExit < p.cooldown) return false;
    const rq = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rq < p.minRqSol || rq > p.maxRqSol) return false;
    const w = t.trades.filter((x) => now - x.slot <= p.window);
    if (w.length < p.minBuys) return false;
    const buys = w.filter((x) => x.buy);
    if (buys.length < p.minBuys) return false;
    const buyers = new Set(buys.map((x) => x.user));
    if (buyers.size < p.minBuyers) return false;
    const net = netSol(w);
    if (net < p.minNetSol) return false;
    const first = w[0];
    const last = w[w.length - 1];
    if (first.price <= 0 || last.price <= 0) return false;
    const up = last.price / first.price - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    let high = 0;
    for (const x of w) if (x.price > high) high = x.price;
    if (last.price < p.nearHigh * high) return false;
    const half = Math.floor(w.length / 2);
    const oldNet = netSol(w.slice(0, half));
    const newNet = netSol(w.slice(half));
    if (newNet < p.accel * Math.max(oldNet, 0.01)) return false;
    const byBuyer = new Map<string, number>();
    for (const b of buys) byBuyer.set(b.user, (byBuyer.get(b.user) ?? 0) + b.sol);
    let top = 0;
    for (const v of byBuyer.values()) if (v > top) top = v;
    const buySol = buys.reduce((a, b) => a + b.sol, 0);
    if (buySol > 0 && top / buySol > p.maxBuyerShare) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot;
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    const caps = state.hello.caps;

    // --- fold fills: track coins traded, clear probes that sold, refresh held ---
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy' && !f.client_id.startsWith('_')) {
        coinsTraded.add(f.mint);
      }
      if (f.status === 'filled' && f.side === 'sell' && probes.get(f.mint) === true) {
        probes.delete(f.mint);
      }
    }

    // --- fold events into tapes ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint);
        t.created = e.slot;
        t.creator = e.user;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        const sol = Number(BigInt(e.sol_amount)) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        if (t.trades.length > 96) t.trades.splice(0, t.trades.length - 96);
      } else {
        const t = tapes.get(e.mint);
        if (t !== undefined) t.trades.length = 0;
      }
    }

    // --- exits for held positions ---
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      const curve = state.curves.get(mint);
      if (h === undefined || curve === undefined || curve.complete) continue;
      const value = closeValue(pos.token_amount, curve);
      h.lastValue = value;
      if (value > h.peakValue) h.peakValue = value;
      const cost = h.invested;
      let exit = false;
      if (value <= cost * (1 - p.stopLoss)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
      if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
      if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
      if (!exit) {
        const t = tapes.get(mint);
        if (t !== undefined) {
          const fade = t.trades.filter((x) => now - x.slot <= p.fadeWindow);
          if (fade.length > 0 && netSol(fade) < -p.fadeNetSol) exit = true;
          if (!exit) {
            for (const x of fade) {
              if (!x.buy && x.sol >= p.bigSellSol) { exit = true; break; }
              if (t.creator !== null && !x.buy && x.user === t.creator) { exit = true; break; }
            }
          }
        }
      }
      if (exit && !probes.has(mint)) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        const t = tapeFor(mint);
        t.lastExit = now;
        held.delete(mint);
      }
    }

    // --- entries + pyramids ---
    const openMain = [...held.keys()].length;
    let exposure = 0;
    for (const h of held.values()) exposure += h.invested;
    const slots = caps.max_open_positions - state.committedPositionCount();

    // Refresh held records for positions that filled since last batch.
    for (const [mint, pos] of state.positions) {
      let h = held.get(mint);
      if (h === undefined) {
        const curve = state.curves.get(mint);
        const px = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
        h = { opened: now, peakValue: 0, invested: Number(pos.cost_lamports) / LAMPORTS, lastAddPrice: px, lastValue: 0 };
        held.set(mint, h);
      }
    }

    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event === 'CreateEvent') continue;
      const mint = e.mint;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const h = held.get(mint);
      const t = tapes.get(mint);

      if (h !== undefined) {
        // Pyramid into strength only.
        if (probes.has(mint) || h.invested >= p.stakeSol) continue;
        if (exposure + p.addSol > p.maxExposureSol) continue;
        if (slots <= 0 && state.committedPositionCount() >= caps.max_open_positions) continue;
        const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (px < h.lastAddPrice * (1 + p.addStep)) continue;
        if (h.lastValue < h.invested * (1 + p.addIfUp)) continue;
        if (t !== undefined) {
          const w = t.trades.filter((x) => now - x.slot <= p.window);
          if (netSol(w) < p.addNetSol) continue;
        }
        let amount = BigInt(Math.floor(p.addSol * LAMPORTS));
        const cap = state.maxBuyLamports(mint);
        if (amount > cap) amount = cap;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += p.addSol;
        h.invested += p.addSol;
        h.lastAddPrice = px;
        continue;
      }

      // Fresh entry.
      if (openMain >= p.maxMain) continue;
      if (exposure + p.initialSol > p.maxExposureSol) continue;
      if (slots <= 0) continue;
      if (!signal(mint, curve, now)) continue;
      let amount = BigInt(Math.floor(p.initialSol * LAMPORTS));
      const cap = state.maxBuyLamports(mint);
      if (amount > cap) amount = cap;
      if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
      free -= amount + tx;
      exposure += p.initialSol;
      const tt = tapeFor(mint);
      tt.entries += 1;
      held.set(mint, {
        opened: now,
        peakValue: 0,
        invested: p.initialSol,
        lastAddPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
        lastValue: 0,
      });
    }

    // --- guardrail pacing: probe round trips when the coin count lags ---
    const elapsed = now - firstSlot;
    let need = 0;
    for (let i = 0; i < p.paceMilestones.length; i++) {
      if (elapsed >= p.paceMilestones[i] && coinsTraded.size < p.paceCoins[i]) {
        need = Math.max(need, p.paceCoins[i] - coinsTraded.size);
      }
    }
    if (need > 0 && probeCount < 40) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (need <= 0) break;
        if (held.has(mint) || probes.has(mint) || curve.complete) continue;
        if (coinsTraded.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rq < 5 || curve.trades < 5) continue;
        let amount = BigInt(Math.floor(p.probeSol * LAMPORTS));
        const cap = state.maxBuyLamports(mint);
        if (amount > cap) amount = cap;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        probes.set(mint, false);
        probeCount += 1;
        need -= 1;
      }
    }

    // --- sell probes as soon as their buy lands ---
    for (const [mint, selling] of probes) {
      if (selling) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const pendingBuy = [...state.pending.values()].some((po) => po.order.side === 'buy' && po.order.mint === mint);
      if (pendingBuy) continue;
      const pendingSell = [...state.pending.values()].some((po) => po.order.side === 'sell' && po.order.mint === mint);
      if (pendingSell) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      probes.set(mint, true);
    }

    return orders;
  }

  return { onBatch };
}
