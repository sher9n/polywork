// Polymarket CLOB WebSocket client. Streams trade events in real-time
// (eliminating the ~4 min Data API lag) by subscribing to market channels
// per CLOB asset_id.
//
// Design:
//   - On startup, fetches asset_ids for "interesting" markets (those in agent
//     price ranges, not resolved). Subscribes to each.
//   - On `trade` messages, calls the supplied handler with a trade shaped
//     identically to the polled /trades response so downstream dispatch is
//     unchanged.
//   - Reconnects on disconnect with exponential backoff.
//   - Subscriptions refresh every WS_REFRESH_INTERVAL_MS to pick up newly-
//     created markets.
//
// Enable: set POLYMARKET_WS_ENABLED=true in env. The polling loop remains
// active as a fallback (dedup via lastSeenTs prevents double-processing).

import type { Sql } from "postgres";

// Default Polymarket CLOB WebSocket URL. Verify before enabling; if wrong,
// the client logs the error and stays disconnected (poll fallback continues).
const WS_URL = process.env.POLYMARKET_WS ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const WS_REFRESH_INTERVAL_MS = 30 * 60_000;     // refresh subscription list every 30 min
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const GAMMA = process.env.POLYMARKET_GAMMA ?? "https://gamma-api.polymarket.com";

export type LiveTradeMsg = {
  conditionId: string;
  outcome: "Yes" | "No";
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  proxyWallet?: string;
};

export type WsClient = {
  start: () => void;
  stop: () => void;
  isConnected: () => boolean;
  subscribedMarkets: () => number;
};

// Resolves token_id -> { conditionId, outcome } so we can decode trade events.
type AssetMap = Map<string, { conditionId: string; outcome: "Yes" | "No" }>;

async function fetchInterestingAssets(sql: Sql, priceLow: number, priceHigh: number): Promise<AssetMap> {
  // Active markets in agent price ranges, with clob tokens.
  const rows = await sql<Array<{ condition_id: string; current_yes_price: number | null }>>`
    SELECT condition_id, current_yes_price FROM live_market_state
    WHERE resolved_outcome IS NULL
      AND end_date > NOW()
      AND (
        current_yes_price IS NULL
        OR (current_yes_price BETWEEN ${priceLow} AND ${priceHigh})
        OR (current_yes_price BETWEEN ${1 - priceHigh} AND ${1 - priceLow})
      )
    LIMIT 500
  `;

  const map: AssetMap = new Map();
  // Hit gamma to get clob token ids per condition. Batch in chunks.
  const cids = rows.map((r) => r.condition_id);
  for (let i = 0; i < cids.length; i += 20) {
    const chunk = cids.slice(i, i + 20);
    try {
      const resp = await fetch(`${GAMMA}/markets?condition_ids=${chunk.join(",")}&limit=20`);
      if (!resp.ok) continue;
      const markets = await resp.json() as Array<{ conditionId?: string; clobTokenIds?: string }>;
      for (const m of markets) {
        if (!m.conditionId || !m.clobTokenIds) continue;
        try {
          const ids = JSON.parse(m.clobTokenIds) as string[];
          if (ids.length === 2) {
            map.set(ids[0], { conditionId: m.conditionId, outcome: "Yes" });
            map.set(ids[1], { conditionId: m.conditionId, outcome: "No" });
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return map;
}

export function createWsClient(sql: Sql, opts: {
  onTrade: (t: LiveTradeMsg) => Promise<void> | void;
  priceLow: number;
  priceHigh: number;
}): WsClient {
  let ws: WebSocket | null = null;
  let stopping = false;
  let reconnectMs = RECONNECT_BASE_MS;
  let assetMap: AssetMap = new Map();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshAssets(): Promise<void> {
    try {
      assetMap = await fetchInterestingAssets(sql, opts.priceLow, opts.priceHigh);
      console.log(`[ws] refreshed asset list: ${assetMap.size} tokens`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Re-subscribe to the new list.
        sendSubscribe();
      }
    } catch (e) {
      console.error(`[ws] refresh assets failed: ${(e as Error).message}`);
    }
  }

  function sendSubscribe(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const tokenIds = Array.from(assetMap.keys());
    if (tokenIds.length === 0) return;
    // CLOB websocket subscription format (verify against Polymarket docs).
    const msg = { type: "MARKET", assets_ids: tokenIds };
    ws.send(JSON.stringify(msg));
    console.log(`[ws] subscribed to ${tokenIds.length} markets`);
  }

  function connect(): void {
    if (stopping) return;
    console.log(`[ws] connecting to ${WS_URL}...`);
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error(`[ws] connect threw: ${(e as Error).message} - retrying in ${reconnectMs}ms`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      console.log("[ws] connected");
      reconnectMs = RECONNECT_BASE_MS;
      sendSubscribe();
    });

    ws.addEventListener("message", async (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
        const msg = JSON.parse(data) as Record<string, unknown>;
        // Trade messages on the market channel have shape:
        //   { event_type: "trade", asset_id, price, size, side, timestamp, ... }
        // The exact field names vary; this is a best-effort parser.
        if (msg.event_type === "trade" || msg.type === "trade") {
          const assetId = (msg.asset_id ?? msg.assetId) as string | undefined;
          if (!assetId) return;
          const meta = assetMap.get(assetId);
          if (!meta) return;
          const price = Number(msg.price);
          const size = Number(msg.size);
          const side = (msg.side as string ?? "BUY").toUpperCase() as "BUY" | "SELL";
          const tsRaw = msg.timestamp ?? msg.match_time ?? msg.ts;
          const ts = typeof tsRaw === "number" ? (tsRaw > 1e12 ? tsRaw / 1000 : tsRaw) : Math.floor(Date.now() / 1000);
          if (!Number.isFinite(price) || !Number.isFinite(size)) return;
          await opts.onTrade({
            conditionId: meta.conditionId,
            outcome: meta.outcome,
            side,
            price,
            size,
            timestamp: ts,
            proxyWallet: msg.maker_address as string | undefined,
          });
        }
      } catch (e) {
        // Don't let a malformed message kill the loop.
        if (process.env.POLYWORK_WS_DEBUG === "true") {
          console.error(`[ws] message parse error: ${(e as Error).message}`);
        }
      }
    });

    ws.addEventListener("close", () => {
      console.log(`[ws] closed - reconnecting in ${reconnectMs}ms`);
      scheduleReconnect();
    });

    ws.addEventListener("error", (ev: Event) => {
      console.error(`[ws] error: ${(ev as ErrorEvent).message ?? "(unknown)"}`);
      try { ws?.close(); } catch { /* ignore */ }
    });
  }

  function scheduleReconnect(): void {
    if (stopping) return;
    setTimeout(() => {
      reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectMs);
  }

  return {
    start: () => {
      stopping = false;
      void refreshAssets().then(() => connect());
      refreshTimer = setInterval(() => { void refreshAssets(); }, WS_REFRESH_INTERVAL_MS);
    },
    stop: () => {
      stopping = true;
      if (refreshTimer) clearInterval(refreshTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
    isConnected: () => ws !== null && ws.readyState === WebSocket.OPEN,
    subscribedMarkets: () => assetMap.size,
  };
}
