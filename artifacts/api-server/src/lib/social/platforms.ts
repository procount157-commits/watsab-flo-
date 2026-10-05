// ── The three platforms, side by side ─────────────────────────────
// What differs between Instagram, TikTok and LinkedIn is small and listed
// here: where they live, how a link to a post or a person is written, how much
// a day an account can safely do, and how a first contact is made. Everything
// else — the team, the gate, the drafts, the approvals — is one code path.
//
// The caps are low on purpose. None of the three documents its limits, and
// all three enforce them by restricting the account rather than by refusing
// the action, so a cap is a guess at the safe side of a line nobody shows you.

import type { SocialPlatform } from "@workspace/db";
export type { SocialPlatform };
export const PLATFORMS = ["instagram", "tiktok", "linkedin"] as const;

/** Every kind of action the gate counts, each with its own daily cap. */
export const ACTION_KINDS = ["reply", "dm", "outreach", "followup", "post", "engage"] as const;
export type ActionKind = typeof ACTION_KINDS[number];

/** The action names written to social_actions that count toward each kind. */
export const COUNTS_AS: Record<ActionKind, string[]> = {
  reply: ["reply_comment"],
  dm: ["send_dm"],
  outreach: ["outreach_dm", "connect"],
  followup: ["followup_dm"],
  post: ["publish_post"],
  engage: ["engage_comment"],
};

export type PlatformDef = {
  key: SocialPlatform;
  label: string;
  labelAr: string;
  /** Role prefix: ig_watcher, tt_watcher, li_watcher. */
  prefix: "ig" | "tt" | "li";
  home: string;
  caps: Record<ActionKind, number>;
  pace: { minGapMs: number; restEvery: number; restMs: readonly [number, number]; hours: readonly [number, number] };
  /** How a first contact is made: a message, or (LinkedIn) an invitation, then a message once accepted. */
  firstContact: "dm" | "connect";
  /** Longest first message the platform takes in that first contact. */
  firstContactMax: number;
  /** A follow-up waits this long after the first message, and there is only one. */
  followupAfterDays: number;
  /** What a public reply / a post / a DM should read like here. */
  voice: string;
};

export const PLATFORM: Record<SocialPlatform, PlatformDef> = {
  instagram: {
    key: "instagram", label: "Instagram", labelAr: "إنستجرام", prefix: "ig", home: "https://www.instagram.com",
    caps: { reply: 40, dm: 25, outreach: 10, followup: 10, post: 1, engage: 10 },
    pace: { minGapMs: 45_000, restEvery: 8, restMs: [4 * 60_000, 11 * 60_000], hours: [8, 23] },
    firstContact: "dm", firstContactMax: 600, followupAfterDays: 4,
    voice: "إنستجرام: قصير وودود وبصري. الرد العلني سطر أو سطران. الرسالة الخاصة الأولى ٣–٤ أسطر.",
  },
  tiktok: {
    key: "tiktok", label: "TikTok", labelAr: "تيك توك", prefix: "tt", home: "https://www.tiktok.com",
    // TikTok's web client is the most suspicious of the three: wider gaps and lower caps.
    caps: { reply: 30, dm: 20, outreach: 8, followup: 8, post: 1, engage: 10 },
    pace: { minGapMs: 60_000, restEvery: 6, restMs: [5 * 60_000, 14 * 60_000], hours: [9, 23] },
    firstContact: "dm", firstContactMax: 500, followupAfterDays: 4,
    voice: "تيك توك: عفوي وسريع وخفيف، بلا رسمية. التعليق سطر واحد غالباً. الرسالة الخاصة الأولى ٢–٣ أسطر.",
  },
  linkedin: {
    key: "linkedin", label: "LinkedIn", labelAr: "لينكدإن", prefix: "li", home: "https://www.linkedin.com",
    // A message reaches only a first-degree connection, so a first contact is
    // an invitation; LinkedIn allows roughly a hundred a week before it warns.
    caps: { reply: 30, dm: 30, outreach: 15, followup: 10, post: 1, engage: 15 },
    pace: { minGapMs: 40_000, restEvery: 8, restMs: [4 * 60_000, 10 * 60_000], hours: [8, 21] },
    firstContact: "connect", firstContactMax: 300, followupAfterDays: 5,
    voice: "لينكدإن: مهني ومباشر، بالإنجليزية افتراضياً، كما يكتب مدير لمدير. لا رموز تعبيرية. رسالة الدعوة أقل من ٣٠٠ حرف.",
  },
};

export const isPlatform = (v: unknown): v is SocialPlatform => typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);

export function capsFor(platform: SocialPlatform, overrides?: Partial<Record<string, number>> | null): Record<ActionKind, number> {
  const base = { ...PLATFORM[platform].caps };
  for (const k of ACTION_KINDS) {
    const v = Number(overrides?.[k]);
    if (Number.isFinite(v) && v >= 0) base[k] = Math.min(Math.round(v), base[k] * 3);
  }
  return base;
}

// ── Links ────────────────────────────────────────────────────────
/** A post link → the id it is stored under, or null when it is not a post. */
export function postIdOf(platform: SocialPlatform, url: string): string | null {
  const u = url.trim();
  if (platform === "instagram") return /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(u)?.[1] ?? null;
  if (platform === "tiktok") return /tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i.exec(u)?.[1] ?? null;
  return /linkedin\.com\/.*?(?:activity[:-]|ugcPost[:-]|share[:-])(\d{10,})/i.exec(u)?.[1] ?? null;
}

/**
 * A person as the owner pasted them — a link, @name, or a bare name — as the
 * handle we key on and the profile link we open.
 */
export function personOf(platform: SocialPlatform, input: string): { handle: string; profileUrl: string } | null {
  const v = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!v) return null;
  if (platform === "linkedin") {
    const m = /linkedin\.com\/(in|company)\/([^/]+)/i.exec(v);
    if (m) return { handle: `${m[1]!.toLowerCase() === "company" ? "company/" : ""}${decodeURIComponent(m[2]!).toLowerCase()}`, profileUrl: `https://www.linkedin.com/${m[1]!.toLowerCase()}/${m[2]}/` };
    if (/^[a-z0-9-]{3,100}$/i.test(v)) return { handle: v.toLowerCase(), profileUrl: `https://www.linkedin.com/in/${v}/` };
    return null;
  }
  if (platform === "tiktok") {
    const m = /tiktok\.com\/@([A-Za-z0-9._]+)/i.exec(v) ?? /^@?([A-Za-z0-9._]{2,24})$/.exec(v);
    return m ? { handle: m[1]!.toLowerCase(), profileUrl: `https://www.tiktok.com/@${m[1]}` } : null;
  }
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(v) ?? /^@?([A-Za-z0-9._]{1,30})$/.exec(v);
  if (!m || /^(p|reel|reels|explore|direct|accounts|stories|tv)$/i.test(m[1]!)) return null;
  return { handle: m[1]!.toLowerCase(), profileUrl: `https://www.instagram.com/${m[1]}/` };
}

/** Gulf time, which every desk keeps. */
export const gulfHour = (d = new Date()) => (d.getUTCHours() + 4) % 24;
