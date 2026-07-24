/**
 * On-chain client (Polygon) — maker/taker reconstruction, the load-bearing piece
 * for H2. The clean maker/taker role is NOT in any public per-wallet API (the CLOB
 * field is auth-gated to one's own wallet), so we reconstruct it from CTF Exchange
 * `OrderFilled` logs. Each log's indexed topics are:
 *     topic[0] = event signature (OrderFilled)
 *     topic[1] = orderHash
 *     topic[2] = maker   (the resting order's owner)
 *     topic[3] = taker   (the aggressor / common counterparty of the tx)
 * so a wallet's role on a fill is unambiguous from the topics alone.
 *
 * The non-indexed data words are decoded PROVISIONALLY (positions observed in
 * Phase 0: [0]=makerAssetId, [1]=takerAssetId, [2]=makerAmountFilled,
 * [3]=takerAmountFilled, [4]=fee). This matched the /trades cash amounts exactly
 * for a real fill, but the exact V2 ABI must be confirmed against the verified
 * contract before these amount/fee fields feed a published number (spec §8).
 *
 * Read-only. Uses POLYGON_RPC_URL if set, else public endpoints. Never a wallet key.
 */
import {
  EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPIC_V2,
  TOKEN_SCALE,
  polygonRpcUrls,
} from "../config/constants.ts";
import { rpcCall } from "./http.ts";

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string;
}
interface RpcReceipt {
  blockNumber: string;
  transactionHash: string;
  logs: RpcLog[];
}

/** 32-byte topic -> lowercase 0x address (last 20 bytes). */
function topicToAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/** i-th 32-byte word of a log `data` blob as a bigint. */
function dataWord(data: string, i: number): bigint {
  const start = 2 + i * 64;
  const hex = data.slice(start, start + 64);
  if (hex.length < 64) return 0n;
  return BigInt("0x" + hex);
}

export type FillRole = "maker" | "taker";

export interface OrderFilledFill {
  orderHash: string;
  role: FillRole; // role of the audited wallet
  maker: string;
  taker: string;
  counterparty: string; // the other side, from the audited wallet's perspective
  exchange: string;
  makerAssetId: bigint; // 0 == collateral (USDC/pUSD); else outcome-token id
  takerAssetId: bigint;
  makerAmount: number; // provisional decode, human units (÷ 1e6)
  takerAmount: number;
  fee: number; // provisional decode, human units — expect 0 on maker legs
}

/** Fetch a transaction receipt via Polygon RPC (with endpoint failover). */
export async function getTransactionReceipt(txHash: string): Promise<RpcReceipt | null> {
  const res = await rpcCall(polygonRpcUrls(), "eth_getTransactionReceipt", [txHash]);
  return (res as RpcReceipt | null) ?? null;
}

/**
 * Extract, from a receipt, the OrderFilled fills in which `wallet` participated,
 * tagging its maker/taker role. Skips the aggregate "netting" leg where the taker
 * side is the exchange contract itself (avoids double counting).
 */
export function extractWalletFills(receipt: RpcReceipt, wallet: string): OrderFilledFill[] {
  const w = wallet.toLowerCase();
  const out: OrderFilledFill[] = [];
  for (const log of receipt.logs) {
    if (!EXCHANGE_ADDRESSES.has(log.address.toLowerCase())) continue;
    if (log.topics[0]?.toLowerCase() !== ORDER_FILLED_TOPIC_V2) continue;
    if (log.topics.length < 4) continue;

    const maker = topicToAddress(log.topics[2]);
    const taker = topicToAddress(log.topics[3]);
    // The aggregate leg has taker == exchange; ignore it for per-wallet role.
    if (EXCHANGE_ADDRESSES.has(taker)) continue;

    let role: FillRole;
    let counterparty: string;
    if (maker === w) {
      role = "maker";
      counterparty = taker;
    } else if (taker === w) {
      role = "taker";
      counterparty = maker;
    } else {
      continue; // this fill does not involve the audited wallet
    }

    out.push({
      orderHash: log.topics[1],
      role,
      maker,
      taker,
      counterparty,
      exchange: log.address.toLowerCase(),
      makerAssetId: dataWord(log.data, 0),
      takerAssetId: dataWord(log.data, 1),
      makerAmount: Number(dataWord(log.data, 2)) / TOKEN_SCALE,
      takerAmount: Number(dataWord(log.data, 3)) / TOKEN_SCALE,
      fee: Number(dataWord(log.data, 4)) / TOKEN_SCALE,
    });
  }
  return out;
}
