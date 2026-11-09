// The platforms a desk can drive. A platform without a driver has no browser
// actions: its team, lists and drafts exist, and nothing is done on the site.
import type { SocialPlatform } from "../platforms";
import type { Driver } from "./common";
import { instagram } from "./instagram";
import { tiktok } from "./tiktok";
import { currentAgent } from "../../agent-context";
import { gateSend } from "../../org/gateway";
import type { Channel } from "../../org/controls";

export const DRIVERS: Partial<Record<SocialPlatform, Driver>> = { instagram, tiktok };
export const hasDriver = (p: SocialPlatform): boolean => !!DRIVERS[p];

/**
 * The driver, with every action that touches another person behind the
 * organisation's gate. The only way to get one, so a new desk cannot forget it.
 * Reading (inbox, comments, search) goes straight through: it sends nothing.
 */
export const driverFor = (p: SocialPlatform, userId: number): Driver | null => {
  const d = DRIVERS[p];
  if (!d) return null;
  const pass = async (kind: string, recipient: string | null | undefined) =>
    gateSend({ userId, channel: p as Channel, kind, recipient: recipient ?? null, role: currentAgent()?.role ?? null });
  const no = (why: string | null) => ({ ok: false as const, error: why ?? "موقوف" });
  return {
    ...d,
    replyToComment: async (page, url, comment, reply) => {
      const g = await pass("reply_comment", comment.author);
      return g.allowed ? d.replyToComment(page, url, comment, reply) : no(g.why);
    },
    sendDm: async (page, to, text, opts) => {
      const g = await pass(opts.fresh ? "outreach" : "dm", to.handle);
      return g.allowed ? d.sendDm(page, to, text, opts) : no(g.why);
    },
    publish: async (page, text) => {
      const g = await pass("post", null);
      return g.allowed ? d.publish(page, text) : no(g.why);
    },
    commentOn: async (page, postUrl, text) => {
      const g = await pass("engage", postUrl);
      return g.allowed ? d.commentOn(page, postUrl, text) : no(g.why);
    },
    ...(d.connect ? { connect: async (page: Parameters<NonNullable<Driver["connect"]>>[0], url: string, note: string | null) => {
      const g = await pass("outreach", url);
      return g.allowed ? d.connect!(page, url, note) : no(g.why);
    } } : {}),
  };
};
export const DRIVEN = Object.keys(DRIVERS) as SocialPlatform[];
export type { Driver };
