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

// users we put a placeholder banner on, with what it was before
const injectedUsers = new Map<any, any>();

// log a message the first time a given tag shows up, so the debug list
// shows what happens at runtime without being flooded
const traced = new Set<string>();
function traceOnce(tag: string, message: string): void {
    if (traced.has(tag)) return;
    traced.add(tag);
    debug(message);
}

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
    debug("loaded v1.2.0");

    initStorage();

    const UserStore = findByStoreName("UserStore");
    if (!UserStore) {
        debug("userStore not found");
        return;
    }

    // what the stored users look like before anything is patched
    for (const entry of (storage.overrides ?? []) as BannerOverride[]) {
        try {
            const id = entry?.id?.trim();
            if (!id) continue;
            const u = UserStore.getUser(id);
            debug(`override user ${id}: ${u ? `in cache, banner=${String(u.banner)}, getBannerURL=${typeof u.getBannerURL}` : "not in cache"}`);
        } catch (e) {
            debug(`could not inspect ${entry?.id}: ${(e as Error)?.message}`);
        }
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
                // only list the ones that could plausibly be about profiles
                if (/user|profile|member/i.test(key)) debug(`export (not patched): ${key}`);
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
                traceOnce(`get:${key}`, `${key} was called for an overridden user`);
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
        const ok = wrap(UserProfileStore, "getUserProfile", (original, self, args) => {
            const profile = original.apply(self, args);
            if (getOverrideUrl(args[0])) {
                traceOnce("profile", `getUserProfile for an overridden user: ${profile ? `found, banner=${String(profile.banner)}` : "null"}`);
            }
            return withBanner(profile, args[0]);
        });
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

    // the profile screen may read the banner straight off the user object, so
    // give overridden users a placeholder banner there too (restored on unload)
    const okUser = wrap(UserStore, "getUser", (original, self, args) => {
        const user = original.apply(self, args);
        if (user && !user.banner && getOverrideUrl(args[0])) {
            try {
                injectedUsers.set(user, user.banner);
                user.banner = PLACEHOLDER_HASH;
                traceOnce("user", "gave an overridden user a placeholder banner");
            } catch (e) {
                traceOnce("user-fail", `could not set banner on user: ${(e as Error)?.message}`);
            }
        }
        return user;
    });
    if (okUser) {
        patched++;
        debug("patched UserStore.getUser");
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

    injectedUsers.forEach((original, user) => {
        try { user.banner = original; } catch { /* nothing to restore */ }
    });
    injectedUsers.clear();
    traced.clear();

    debug("unloaded");
}
