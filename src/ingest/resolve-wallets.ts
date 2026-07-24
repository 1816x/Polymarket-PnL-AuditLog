/**
 * Username -> proxy-wallet resolution (spec §1).
 *
 * Hard rule: resolve ONLY on an unambiguous exact match. The Gamma public-search
 * endpoint is fuzzy, so "take the first result" would silently mis-map a username
 * to the wrong wallet (this is exactly how BadFallen would be mis-resolved). If a
 * username cannot be resolved unambiguously we mark it `unresolved` and EXCLUDE it
 * — auditing 4 wallets with certainty beats 5 with one wrong.
 */
import { DATA_API, SUBJECTS } from "../config/constants.ts";
import type { SubjectSeed } from "../config/constants.ts";
import { getPublicProfile, searchProfiles } from "../clients/gamma.ts";
import { getJson } from "../clients/http.ts";

export type ResolveStatus = "given" | "resolved" | "unresolved";

export interface ResolvedSubject {
  id: number;
  label: string;
  kind: "address" | "username";
  address: string | null;
  status: ResolveStatus;
  method: string;
  roundTripName: string | null;
  profile: string;
  notes: string[];
}

/** Leaderboard fallback: address for a username, or null. Loosely validated. */
async function leaderboardLookup(username: string): Promise<string | null> {
  try {
    const raw = await getJson(`${DATA_API}/v1/leaderboard?userName=${encodeURIComponent(username)}&limit=50`, {
      label: `leaderboard ${username}`,
    });
    const rows = Array.isArray(raw) ? raw : [];
    for (const r of rows) {
      const rec = r as Record<string, unknown>;
      if (typeof rec.userName === "string" && rec.userName === username && typeof rec.proxyWallet === "string") {
        return rec.proxyWallet.toLowerCase();
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function resolveUsername(seed: Extract<SubjectSeed, { kind: "username" }>): Promise<ResolvedSubject> {
  const notes: string[] = [];
  const base: ResolvedSubject = {
    id: seed.id,
    label: seed.username,
    kind: "username",
    address: null,
    status: "unresolved",
    method: "none",
    roundTripName: null,
    profile: seed.profile,
    notes,
  };

  const results = await searchProfiles(seed.username);

  // 1) exact, case-sensitive
  let matches = results.filter((p) => p.name === seed.username);
  let method = "gamma public-search exact";

  // 2) fall back to case-insensitive exact (lower confidence, noted)
  if (matches.length === 0) {
    matches = results.filter((p) => (p.name ?? "").toLowerCase() === seed.username.toLowerCase());
    if (matches.length > 0) {
      method = "gamma public-search case-insensitive";
      notes.push(`no exact-case match; matched case-insensitively as "${matches[0].name}"`);
    }
  }

  if (matches.length === 1) {
    const address = matches[0].proxyWallet.toLowerCase();
    const rt = await getPublicProfile(address);
    const rtName = rt?.name ?? null;
    if (rtName && rtName.toLowerCase() !== seed.username.toLowerCase()) {
      notes.push(`round-trip name "${rtName}" != "${seed.username}" — treat with caution`);
    }
    return { ...base, address, status: "resolved", method, roundTripName: rtName };
  }

  if (matches.length > 1) {
    notes.push(`AMBIGUOUS: ${matches.length} exact matches — excluding rather than guessing`);
  } else {
    notes.push(`no exact match on public-search (fuzzy neighbors: ${results.map((p) => p.name).filter(Boolean).slice(0, 6).join(", ") || "none"})`);
    // 3) leaderboard fallback
    const lb = await leaderboardLookup(seed.username);
    if (lb) {
      const rt = await getPublicProfile(lb);
      notes.push("resolved via leaderboard fallback");
      return { ...base, address: lb, status: "resolved", method: "data leaderboard", roundTripName: rt?.name ?? null };
    }
  }

  return base; // unresolved -> excluded
}

async function resolveAddress(seed: Extract<SubjectSeed, { kind: "address" }>): Promise<ResolvedSubject> {
  const address = seed.address.toLowerCase();
  const rt = await getPublicProfile(address);
  return {
    id: seed.id,
    label: `${address.slice(0, 10)}…`,
    kind: "address",
    address,
    status: "given",
    method: "provided in article",
    roundTripName: rt?.name ?? rt?.pseudonym ?? null,
    profile: seed.profile,
    notes: [],
  };
}

/** Resolve all five subjects. Usernames that don't resolve unambiguously stay `unresolved`. */
export async function resolveSubjects(): Promise<ResolvedSubject[]> {
  const out: ResolvedSubject[] = [];
  for (const seed of SUBJECTS) {
    out.push(seed.kind === "address" ? await resolveAddress(seed) : await resolveUsername(seed));
  }
  return out;
}
