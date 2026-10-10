import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";

import { resetStatus, status } from "./status";

const VERSION = "1.5.0";

// placeholder banner hash, only used so the profile UI renders a banner area
// for users who have no banner of their own; the real image comes from the override
const PLACEHOLDER_HASH = "override-user-banner";

let patches: (() => void)[] = [];

// users and profiles we put a placeholder banner on, with what it was before
const injected = new Map<any, any>();

// display profiles (what the profile screen reads) that are already handled
const handledProfiles = new WeakSet<object>();

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

// wraps obj[key] so that `wrapper(original, self, args)` runs instead, and
// registers a function that puts the original back on unload
function wrap(obj: any, key: string, wrapper: (original: Function, self: any, args: any[]) => any): boolean {
    try {
        const original = obj?.[key];
        if (typeof original !== "function") return false;

        obj[key] = function (...args: any[]) {
            return wrapper(original, this, args);
        };
        patches.push(() => { obj[key] = original; });
        return true;
    } catch {
        return false;
    }
}

// gives a user or profile of an overridden user a banner so the profile screen
// draws the banner area. changed in place (and restored on unload) so any
// methods on the object keep working
function addPlaceholderBanner(target: any, userId?: string): void {
    if (!target || target.banner || !getOverrideUrl(userId)) return;
    try {
        injected.set(target, target.banner);
        target.banner = PLACEHOLDER_HASH;
    } catch {
        // frozen objects are left alone
    }
}

// the profile screen builds its banner from a "displayProfile" object, so
// that object's getBannerURL is pointed at the override
function patchDisplayProfile(profile: any, userId?: string): void {
    if (!profile || typeof profile !== "object" || handledProfiles.has(profile)) return;

    const id = userId ?? profile.userId;
    if (!getOverrideUrl(id)) return;
    handledProfiles.add(profile);

    const original = profile.getBannerURL;
    try {
        if (!profile.banner) {
            Object.defineProperty(profile, "banner", { value: PLACEHOLDER_HASH, configurable: true, writable: true, enumerable: true });
        }
        Object.defineProperty(profile, "getBannerURL", {
            value: function (...args: any[]) {
                // looked up again on every call so edits and removals apply at once
                return getOverrideUrl(id) ?? (typeof original === "function" ? original.apply(profile, args) : undefined);
            },
            configurable: true,
            writable: true,
            enumerable: true,
        });
    } catch {
        // frozen objects are left alone
    }
}

// the hook the profile screen calls with { user, displayProfile, ... }
function bannerHookWrapper(original: Function, self: any, args: any[]) {
    for (const arg of args) {
        if (arg && typeof arg === "object" && arg.displayProfile) {
            patchDisplayProfile(arg.displayProfile, arg.user?.id);
        }
    }
    return original.apply(self, args);
}

// getUserBannerURL and friends, for any screen that builds a banner URL itself
function urlGetterWrapper(original: Function, self: any, args: any[]) {
    const first = args[0];
    const id = typeof first === "string" ? first : first?.id;
    return getOverrideUrl(id) ?? original.apply(self, args);
}

function patchUrlGetter(name: string): boolean {
    const mod = findByProps(name);
    return !!mod && wrap(mod, name, urlGetterWrapper);
}

// profile lookups: hands back the profile with a placeholder banner on it
function profileWrapper(original: Function, self: any, args: any[]) {
    const profile = original.apply(self, args);
    addPlaceholderBanner(profile, args[0]);
    return profile;
}

function applyPatches(): void {
    resetStatus();
    status(`loaded v${VERSION}`);

    initStorage();

    const UserStore = findByStoreName("UserStore");
    if (!UserStore) {
        status("user store not found, nothing patched");
        return;
    }

    // a placeholder left behind by an earlier load that was not unloaded
    for (const entry of (storage.overrides ?? []) as BannerOverride[]) {
        try {
            const user = entry?.id ? UserStore.getUser(entry.id.trim()) : null;
            if (user && user.banner === PLACEHOLDER_HASH) user.banner = null;
        } catch {
            // nothing to clean up
        }
    }

    // the profile screen's banner
    const hookModule = findByProps("useUserProfileBannerBackgroundColor");
    const hookOk = !!hookModule && wrap(hookModule, "useUserProfileBannerBackgroundColor", bannerHookWrapper);
    status(hookOk ? "profile screen banner: patched" : "profile screen banner: NOT FOUND, banners will not show there");

    // anything else that builds a banner URL
    const getters = ["getUserBannerURL", "getGuildMemberBannerURL"].filter(patchUrlGetter);
    status(`banner URL functions patched: ${getters.length ? getters.join(", ") : "none"}`);

    // profile stores, so users without a banner still get one drawn
    const UserProfileStore = findByStoreName("UserProfileStore");
    const profilesOk = !!UserProfileStore && [
        wrap(UserProfileStore, "getUserProfile", profileWrapper),
        wrap(UserProfileStore, "getGuildMemberProfile", profileWrapper),
    ].some(Boolean);
    status(profilesOk ? "profile store: patched" : "profile store: NOT FOUND");

    // same for the user object itself
    const userOk = wrap(UserStore, "getUser", (original, self, args) => {
        const user = original.apply(self, args);
        addPlaceholderBanner(user, args[0]);
        return user;
    });
    status(userOk ? "user store: patched" : "user store: NOT FOUND");

    // refresh ui for every overridden user
    for (const entry of (storage.overrides ?? []) as BannerOverride[]) {
        try {
            const user = entry?.id ? UserStore.getUser(entry.id.trim()) : null;
            if (user) {
                FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
            }
        } catch {
            // the next time the profile opens will show it anyway
        }
    }
}

export function onLoad(): void {
    // an exception here would stop the plugin silently, so keep it visible
    try {
        applyPatches();
    } catch (e) {
        status(`crashed on load: ${(e as Error)?.message}`);
    }
}

export function onUnload(): void {
    // restore patches
    patches.forEach(unpatch => unpatch());
    patches = [];

    injected.forEach((original, target) => {
        try { target.banner = original; } catch { /* nothing to restore */ }
    });
    injected.clear();
}
