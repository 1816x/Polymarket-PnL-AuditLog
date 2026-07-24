/**
 * Gamma API client — profile resolution.
 *
 * Used for username -> proxy-wallet resolution. NOTE (Phase 0 finding): Gamma's
 * /markets lookup by condition_ids is unreliable for freshly-resolved short-term
 * markets (returns [] intermittently), so settlement is read from the CLOB client
 * instead; Gamma here is scoped to profiles.
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
