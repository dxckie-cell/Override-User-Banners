import { findAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

import { debug } from "./debug";

// placeholder banner hash, only used so the profile UI renders a banner area
// for users who have no banner of their own; the URL getter swaps it out
const PLACEHOLDER_HASH = "override-user-banner";

const BANNER_KEY = /banner/i;

let patches: (() => void)[] = [];

export { default as settings } from "./settings";

export interface BannerOverride {
    id: string;
    url: string;
}

function initStorage(): void {
    if (!Array.isArray(storage.overrides)) {
        storage.overrides = [];
    }
}

// looks up the override at call time so edits in settings apply without reloading
function getOverrideUrl(userId?: string): string | undefined {
    if (!userId) return undefined;
    const list: BannerOverride[] = storage.overrides ?? [];
    for (const entry of list) {
        if (entry?.id?.trim() === userId && entry.url?.trim()) {
            return entry.url.trim();
        }
    }
    return undefined;
}

// wraps obj[key] so that `wrapper(original, ...args)` runs instead, and
// registers a function that puts the original back on unload
function wrap(obj: any, key: string, wrapper: (original: Function, self: any, args: any[]) => any): boolean {
    const original = obj?.[key];
    if (typeof original !== "function") return false;

    obj[key] = function (...args: any[]) {
        return wrapper(original, this, args);
    };
    patches.push(() => { obj[key] = original; });
    return true;
}

// gives profiles of overridden users a banner so the UI shows the banner area
function withBanner(profile: any, userId?: string) {
    if (!profile || !getOverrideUrl(userId)) return profile;
    if (profile.banner) return profile;
    return { ...profile, banner: PLACEHOLDER_HASH };
}

function applyPatches(): void {
    debug("loaded v1.1.1");

    initStorage();

    const UserStore = findByStoreName("UserStore");
    if (!UserStore) {
        debug("userStore not found");
        return;
    }

    let patched = 0;

    // patch every banner getter we can find, since the name differs between builds.
    // anything like getUserBannerURL / getUserBannerSource is wrapped, and every
    // banner-looking export is listed so a missing one can be spotted
    let modules: any[] = [];
    try {
        modules = findAll((m: any) => {
            try {
                return !!m && Object.keys(m).some(k => BANNER_KEY.test(k) && typeof m[k] === "function");
            } catch {
                return false;
            }
        }) as any[];
    } catch (e) {
        debug(`module scan failed: ${(e as Error)?.message}`);
    }
    debug(`found ${modules.length} modules with banner exports`);

    const done = new Set<any>();
    for (const mod of modules) {
        if (done.has(mod)) continue;
        done.add(mod);

        for (const key of Object.keys(mod)) {
            if (!BANNER_KEY.test(key) || typeof mod[key] !== "function") continue;

            // only getters that return a URL or an image source; hooks and
            // components are left alone
            if (!/^get.*(url|source|uri|image)$/i.test(key)) {
                debug(`export (not patched): ${key}`);
                continue;
            }

            const wantsSource = /source$/i.test(key);
            const ok = wrap(mod, key, (original, self, args) => {
                const first = args[0];
                const id = typeof first === "string" ? first : first?.id;
                const overrideUrl = getOverrideUrl(id);
                const result = original.apply(self, args);
                // only intercept users that have an override, ignore everyone else
                if (!overrideUrl) return result;
                if (wantsSource) {
                    return { ...(result && typeof result === "object" ? result : {}), uri: overrideUrl };
                }
                return overrideUrl;
            });
            if (ok) {
                patched++;
                debug(`patched ${key}`);
            }
        }
    }

    // patch the profile store, so users without a banner still get one rendered
    const UserProfileStore = findByStoreName("UserProfileStore");
    if (UserProfileStore) {
        const ok = wrap(UserProfileStore, "getUserProfile", (original, self, args) =>
            withBanner(original.apply(self, args), args[0])
        );
        if (ok) {
            patched++;
            debug("patched UserProfileStore.getUserProfile");
        }

        // per-server profile, args are (userId, guildId)
        const ok2 = wrap(UserProfileStore, "getGuildMemberProfile", (original, self, args) =>
            withBanner(original.apply(self, args), args[0])
        );
        if (ok2) {
            patched++;
            debug("patched UserProfileStore.getGuildMemberProfile");
        }
    } else {
        debug("userProfileStore not found");
    }

    debug(patched === 0 ? "nothing could be patched" : `${patched} patches applied`);

    // refresh ui for every overridden user
    for (const entry of (storage.overrides ?? []) as BannerOverride[]) {
        try {
            const user = entry?.id ? UserStore.getUser(entry.id.trim()) : null;
            if (user) {
                FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
            }
        } catch (e) {
            debug(`could not trigger refresh for ${entry?.id}: ${(e as Error)?.message}`);
        }
    }

    try {
        showToast(`Override User Banners: ${patched} patches`);
    } catch {
        // toast is only a convenience
    }
}

export function onLoad(): void {
    // an exception here would stop the plugin silently, so keep it visible
    try {
        applyPatches();
    } catch (e) {
        debug(`onLoad crashed: ${(e as Error)?.message}`);
    }
}

export function onUnload(): void {
    debug("unloading...");

    // restore patches
    patches.forEach(unpatch => unpatch());
    patches = [];

    debug("unloaded");
}
