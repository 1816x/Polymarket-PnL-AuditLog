/**
 * Gamma API client — profile resolution + batched market metadata.
 *
 * Phase 0 found /markets?condition_ids= "unreliable" for resolved short-term
 * markets. Phase 2 identified the real cause: the endpoint EXCLUDES closed
 * markets unless `closed=true` is passed — a resolved market silently vanishes
 * from the default listing. With closed=true, batches of 40 ids return 40/40
 * (verified live 2026-07-25, incl. 40/40 winner agreement vs CLOB-sourced rows).
 * getClosedMarketsByConditionIds is therefore only valid for CLOSED markets;
 * still-open ones fall through to the CLOB per-id client.
 */
import { z } from "zod";
import { GAMMA_API } from "../config/constants.ts";
import { getJson } from "./http.ts";

const ProfileSchema = z.object({
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
  proxyWallet: z.string(),
  displayUsernamePublic: z.boolean().nullable().optional(),
  bio: z.string().nullable().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const SearchResponseSchema = z.object({
  profiles: z.array(ProfileSchema).nullable().optional(),
});

/**
 * Search public profiles. WARNING: this endpoint is FUZZY/substring — it returns
 * near-matches, not just exact hits. Callers MUST filter on an exact `name` match
 * and treat "no exact match" as a hard failure; never take profiles[0] blindly.
 */
export async function searchProfiles(query: string): Promise<Profile[]> {
  const url = `${GAMMA_API}/public-search?q=${encodeURIComponent(query)}&search_profiles=true&limit_per_type=20`;
  const raw = await getJson(url, { label: `gamma public-search "${query}"` });
  const parsed = SearchResponseSchema.parse(raw);
  return parsed.profiles ?? [];
}

const PublicProfileSchema = z.object({
  proxyWallet: z.string(),
  name: z.string().nullable().optional(),
  pseudonym: z.string().nullable().optional(),
  displayUsernamePublic: z.boolean().nullable().optional(),
});
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

// ---------------------------------------------------------------------------
// Batched market metadata (Phase 2 backfill)
// ---------------------------------------------------------------------------

const GammaMarketSchema = z.object({
  conditionId: z.string(),
  question: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  closed: z.boolean().nullable().optional(),
  closedTime: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  negRisk: z.boolean().nullable().optional(),
  umaResolutionStatus: z.string().nullable().optional(),
  /** JSON-encoded string array of outcome names, e.g. '["Up", "Down"]'. */
  outcomes: z.string().nullable().optional(),
  /** JSON-encoded string array of terminal prices, e.g. '["1", "0"]'. */
  outcomePrices: z.string().nullable().optional(),
  /** JSON-encoded string array of ERC-1155 token ids, aligned with `outcomes`. */
  clobTokenIds: z.string().nullable().optional(),
});
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

/**
 * Fetch metadata for a batch of CLOSED markets by conditionId (max ~40 per call
 * to stay well under URL-length limits). Returns whatever Gamma has — callers
 * must treat missing ids as "not covered" and fall back to the CLOB client.
 * `closed=true` is REQUIRED (see file header); open markets never appear here.
 */
export async function getClosedMarketsByConditionIds(ids: string[]): Promise<GammaMarket[]> {
  if (ids.length === 0) return [];
  const p = new URLSearchParams();
  for (const id of ids) p.append("condition_ids", id);
  p.set("closed", "true");
  p.set("limit", String(Math.max(ids.length, 50)));
  const raw = await getJson(`${GAMMA_API}/markets?${p.toString()}`, {
    label: `gamma markets batch(${ids.length})`,
  });
  return z.array(GammaMarketSchema).parse(raw);
}

/**
 * Reverse lookup address -> profile. This direction is exact and authoritative;
 * use it to round-trip-verify a username resolution.
 */
export async function getPublicProfile(address: string): Promise<PublicProfile | null> {
  const url = `${GAMMA_API}/public-profile?address=${encodeURIComponent(address)}`;
  try {
    const raw = await getJson(url, { label: `gamma public-profile ${address}` });
    return PublicProfileSchema.parse(raw);
  } catch {
    return null;
  }
}
