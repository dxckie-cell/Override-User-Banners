import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[custom-banners]";

// placeholder banner hash, only used so the profile UI renders a banner area
// for users who have no banner of their own; the URL getter swaps it out
const PLACEHOLDER_HASH = "override-user-banner";

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

    // patch the banner URL getter, overrides the banner wherever a URL is built
    const bannerModule = findByProps("getUserBannerURL");
    if (bannerModule) {
        const ok = wrap(bannerModule, "getUserBannerURL", (original, self, args) => {
            const overrideUrl = getOverrideUrl(args[0]?.id);
            // only intercept users that have an override
            if (overrideUrl) return overrideUrl;
            // ignore everyone else
            return original.apply(self, args);
        });
        if (ok) patched++;

        // some builds expose an image source object instead of a plain URL
        const ok2 = wrap(bannerModule, "getUserBannerSource", (original, self, args) => {
            const overrideUrl = getOverrideUrl(args[0]?.id);
            const result = original.apply(self, args);
            if (overrideUrl) {
                return { ...(result ?? {}), uri: overrideUrl };
            }
            return result;
        });
        if (ok2) patched++;
    } else {
        console.log(`${TAG} banner module not found`);
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
