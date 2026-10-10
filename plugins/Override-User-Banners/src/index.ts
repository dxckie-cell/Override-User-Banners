import { findAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

import { debug, debugSlot, resetDebug, shape } from "./debug";

const VERSION = "1.4.0";

// placeholder banner hash, only used so the profile UI renders a banner area
// for users who have no banner of their own; the URL getter swaps it out
const PLACEHOLDER_HASH = "override-user-banner";

const BANNER_KEY = /banner/i;

let patches: (() => void)[] = [];

// users and profiles we put a placeholder banner on, with what it was before
const injected = new Map<any, any>();

// how often each patched function ran, for the debug list
const counters = new Map<string, number>();
function bump(tag: string): number {
    const n = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, n);
    return n;
}

// which things have already had their shape logged
const shapesLogged = new Set<string>();

// display profiles (the object the profile screen reads) already handled
const seenProfiles = new WeakSet<object>();

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
    try {
        const original = obj?.[key];
        if (typeof original !== "function") return false;

        obj[key] = function (...args: any[]) {
            return wrapper(original, this, args);
        };
        patches.push(() => { obj[key] = original; });
        return true;
    } catch (e) {
        debug(`could not patch ${key}: ${(e as Error)?.message}`);
        return false;
    }
}

// gives a profile of an overridden user a banner so the UI shows the banner
// area. the object is changed in place (and restored on unload) so that any
// methods on it keep working; a copy is only used if it can't be changed
function withBanner(profile: any, userId?: string) {
    if (!profile || !getOverrideUrl(userId)) return profile;
    if (profile.banner) return profile;
    try {
        injected.set(profile, profile.banner);
        profile.banner = PLACEHOLDER_HASH;
        return profile;
    } catch {
        return { ...profile, banner: PLACEHOLDER_HASH };
    }
}

function profileWrapper(name: string) {
    return (original: Function, self: any, args: any[]) => {
        const profile = original.apply(self, args);
        if (getOverrideUrl(args[0])) {
            const kind = profile ? "found" : "null";
            const n = bump(`${name}:${kind}`);
            debugSlot(
                `${name}:${kind}`,
                `${name} for an overridden user: ${kind} x${n}` +
                (profile ? `, banner=${String(profile.banner)}, type=${profile.constructor?.name}` : "")
            );
        }
        return withBanner(profile, args[0]);
    };
}

// --- display profile -------------------------------------------------------
// the profile screen passes a "displayProfile" object around instead of
// calling the URL getters, so its banner fields are changed directly

// every banner-looking property name on an object and its prototype chain
function bannerNames(obj: any): string[] {
    const names = new Set<string>();
    let current = obj;
    for (let depth = 0; current && current !== Object.prototype && depth < 6; depth++) {
        try {
            for (const name of Object.getOwnPropertyNames(current)) {
                if (BANNER_KEY.test(name)) names.add(name);
            }
        } catch {
            // skip objects that can't be inspected
        }
        current = Object.getPrototypeOf(current);
    }
    return Array.from(names);
}

function setOwn(obj: any, name: string, value: any): boolean {
    try {
        Object.defineProperty(obj, name, { value, configurable: true, writable: true, enumerable: true });
        return true;
    } catch {
        return false;
    }
}

// what to put in place of the banner property `name`, or undefined to leave it
function replacementFor(name: string, isFn: boolean, current: any, url: string): { value: any } | undefined {
    if (name.toLowerCase() === "banner") {
        return current ? undefined : { value: PLACEHOLDER_HASH };
    }
    if (/source$/i.test(name)) {
        return { value: isFn ? () => ({ uri: url }) : { uri: url } };
    }
    if (/(url|uri)$/i.test(name)) {
        return { value: isFn ? () => url : url };
    }
    if (/^has.*banner/i.test(name)) {
        return { value: isFn ? () => true : true };
    }
    return undefined;
}

function handleDisplayProfile(dp: any, userId?: string): void {
    if (!dp || typeof dp !== "object" || seenProfiles.has(dp)) return;
    seenProfiles.add(dp);

    const names = bannerNames(dp);
    const url = getOverrideUrl(userId ?? dp.userId ?? dp.id);

    const slot = url ? "dp-mine" : "dp-other";
    if (!shapesLogged.has(slot)) {
        shapesLogged.add(slot);
        let keys = "?";
        try { keys = Object.keys(dp).slice(0, 24).join(","); } catch { /* ignore */ }
        debug(
            `${url ? "overridden" : "another"} user's displayProfile: type=${dp.constructor?.name}, ` +
            `banner=${String(dp.banner)}, banner names=[${names.join(",")}], keys=[${keys}]`
        );
    }

    if (!url) return;

    const changed: string[] = [];
    for (const name of names) {
        let isFn = false;
        let current: any;
        try {
            current = dp[name];
            isFn = typeof current === "function";
        } catch {
            continue;
        }
        const replacement = replacementFor(name, isFn, isFn ? undefined : current, url);
        if (replacement && setOwn(dp, name, replacement.value)) changed.push(name);
    }

    const n = bump("dp-changed");
    debugSlot("dp-changed", `changed ${n} displayProfiles of overridden users, last: [${changed.join(",")}]`);
}

// --- per-export patches ----------------------------------------------------
// these are separate functions on purpose: closures made inside a loop shared
// their variables in the built bundle, so every value is passed in instead

function getterWrapper(key: string, isProfileRelated: boolean) {
    const slot = `get:${key}`;
    const wantsSource = /source$/i.test(key);

    return (original: Function, self: any, args: any[]) => {
        const first = args[0];
        const id = typeof first === "string" ? first : first?.id;
        const overrideUrl = getOverrideUrl(id);
        const result = original.apply(self, args);

        const all = bump(`${slot}:all`);
        const mine = overrideUrl ? bump(`${slot}:mine`) : (counters.get(`${slot}:mine`) ?? 0);
        if (isProfileRelated && !shapesLogged.has(slot)) {
            shapesLogged.add(slot);
            debug(`${key} first arg: ${shape(first)}`);
        }
        debugSlot(slot, `patched ${key}: ${all} calls, ${mine} for overridden users`);

        // only intercept users that have an override, ignore everyone else
        if (!overrideUrl) return result;
        if (wantsSource) {
            return { ...(result && typeof result === "object" ? result : {}), uri: overrideUrl };
        }
        return overrideUrl;
    };
}

function hookTracer(key: string) {
    const slot = `hook:${key}`;

    return (original: Function, self: any, args: any[]) => {
        const n = bump(slot);
        if (!shapesLogged.has(slot)) {
            shapesLogged.add(slot);
            debug(`${key} first args: ${args.map(shape).join(" | ")}`);
        }
        debugSlot(slot, `${key} (traced): ${n} calls`);

        for (const arg of args) {
            if (arg && typeof arg === "object" && arg.displayProfile) {
                handleDisplayProfile(arg.displayProfile, arg.user?.id);
            }
        }
        return original.apply(self, args);
    };
}

// patches or traces one export of a module, returns true if it was changed
function patchExport(mod: any, key: string): boolean {
    if (!BANNER_KEY.test(key) || typeof mod[key] !== "function") return false;

    const isGetter = /^get.*(url|source|uri|image)$/i.test(key);
    const isProfileRelated = /profile|member|^useUser/i.test(key);

    if (isGetter) {
        debugSlot(`get:${key}`, `patched ${key}: 0 calls, 0 for overridden users`);
        return wrap(mod, key, getterWrapper(key, isProfileRelated));
    }

    // hooks about profiles are only traced, never changed
    if (/^use/.test(key) && isProfileRelated) {
        debugSlot(`hook:${key}`, `${key} (traced): 0 calls`);
        wrap(mod, key, hookTracer(key));
    } else if (isProfileRelated) {
        debug(`export (not patched): ${key}`);
    }
    return false;
}

function applyPatches(): void {
    resetDebug();
    debug(`loaded v${VERSION}`);

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
            // a placeholder left behind by an earlier load that was not unloaded
            if (u && u.banner === PLACEHOLDER_HASH) {
                try { u.banner = null; } catch { /* leave it */ }
            }
            debug(`override user ${id}: ${u ? `in cache, banner=${String(u.banner)}` : "not in cache"}`);
        } catch (e) {
            debug(`could not inspect ${entry?.id}: ${(e as Error)?.message}`);
        }
    }

    let patched = 0;

    // patch every banner getter we can find, since the name differs between builds
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
            if (patchExport(mod, key)) patched++;
        }
    }

    // patch the profile stores, so users without a banner still get one rendered
    const UserProfileStore = findByStoreName("UserProfileStore");
    if (UserProfileStore) {
        if (wrap(UserProfileStore, "getUserProfile", profileWrapper("getUserProfile"))) {
            patched++;
            debug("patched UserProfileStore.getUserProfile");
        }

        // per-server profile, args are (userId, guildId)
        if (wrap(UserProfileStore, "getGuildMemberProfile", profileWrapper("getGuildMemberProfile"))) {
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
                injected.set(user, user.banner);
                user.banner = PLACEHOLDER_HASH;
                const n = bump("user-inject");
                debugSlot("user-inject", `gave an overridden user a placeholder banner x${n}`);
            } catch (e) {
                debugSlot("user-inject", `could not set banner on user: ${(e as Error)?.message}`);
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
    // restore patches
    patches.forEach(unpatch => unpatch());
    patches = [];

    injected.forEach((original, obj) => {
        try { obj.banner = original; } catch { /* nothing to restore */ }
    });
    injected.clear();
    counters.clear();
    shapesLogged.clear();

    debug("unloaded");
}
