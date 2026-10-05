// The platforms a desk can drive. A platform without a driver has no browser
// actions: its team, lists and drafts exist, and nothing is done on the site.
import type { SocialPlatform } from "../platforms";
import type { Driver } from "./common";
import { instagram } from "./instagram";
import { tiktok } from "./tiktok";

export const DRIVERS: Partial<Record<SocialPlatform, Driver>> = { instagram, tiktok };
export const driverFor = (p: SocialPlatform): Driver | null => DRIVERS[p] ?? null;
export const DRIVEN = Object.keys(DRIVERS) as SocialPlatform[];
export type { Driver };
