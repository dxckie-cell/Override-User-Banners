import { findAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[custom-banners]";

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

export function onLoad(): void {
    console.log(`${TAG} loaded`);

    initStorage();

    const UserStore = findByStoreName("UserStore");
    if (!UserStore) {
        console.log(`${TAG} userStore not found`);
        return;
    }

    let patched = 0;

    // patch every banner getter we can find, since the name differs between builds.
    // anything like getUserBannerURL / getUserBannerSource is wrapped, and every
    // banner-looking export is logged so a missing one can be spotted in logcat
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
        console.log(`${TAG} module scan failed:`, (e as Error)?.message);
    }
    console.log(`${TAG} found ${modules.length} modules with banner exports`);

    const done = new Set<any>();
    for (const mod of modules) {
        if (done.has(mod)) continue;
        done.add(mod);

        for (const key of Object.keys(mod)) {
            if (!BANNER_KEY.test(key) || typeof mod[key] !== "function") continue;
            console.log(`${TAG} banner export: ${key}`);

            // only getters that return a URL or an image source; hooks and
            // components are left alone
            if (!/^get.*(url|source|uri|image)$/i.test(key)) continue;

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
                console.log(`${TAG} patched ${key}`);
            }
        }
    }

    // patch the profile store, so users without a banner still get one rendered
    const UserProfileStore = findByStoreName("UserProfileStore");
    if (UserProfileStore) {
        const ok = wrap(UserProfileStore, "getUserProfile", (original, self, args) =>
            withBanner(original.apply(self, args), args[0])
        );
        if (ok) patched++;

        // per-server profile, args are (userId, guildId)
        const ok2 = wrap(UserProfileStore, "getGuildMemberProfile", (original, self, args) =>
            withBanner(original.apply(self, args), args[0])
        );
        if (ok2) patched++;
    } else {
        console.log(`${TAG} userProfileStore not found`);
    }

    if (patched === 0) {
        console.log(`${TAG} nothing could be patched`);
        return;
    }

    console.log(`${TAG} ${patched} patches applied`);

    // refresh ui for every overridden user
    for (const entry of (storage.overrides ?? []) as BannerOverride[]) {
        try {
            const user = entry?.id ? UserStore.getUser(entry.id.trim()) : null;
            if (user) {
                FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
            }
        } catch (e) {
            console.log(`${TAG} could not trigger refresh for ${entry?.id}:`, (e as Error)?.message);
        }
    }
    console.log(`${TAG} ui refreshed`);
}

export function onUnload(): void {
    console.log(`${TAG} unloading...`);

    // restore patches
    patches.forEach(unpatch => unpatch());
    patches = [];

    console.log(`${TAG} unloaded`);
}
