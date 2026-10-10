// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[custom-banners]";

// kept in memory so the plugin settings screen can show what happened on load,
// since console output does not always reach the in-app log viewer
export const debugLines: string[] = [];

// lines that get rewritten in place (call counters), keyed by name
const slots = new Map<string, number>();

const MAX_LINES = 200;

function print(message: string): void {
    try {
        console.log(`${TAG} ${message}`);
    } catch {
        // logging must never break the plugin
    }
}

export function debug(message: string): void {
    if (debugLines.length < MAX_LINES) debugLines.push(message);
    print(message);
}

// shows one line per slot and rewrites it each time, so counters stay readable
export function debugSlot(slot: string, message: string): void {
    const index = slots.get(slot);
    if (index === undefined) {
        if (debugLines.length >= MAX_LINES) return;
        slots.set(slot, debugLines.length);
        debugLines.push(message);
    } else {
        debugLines[index] = message;
    }
}

export function resetDebug(): void {
    debugLines.length = 0;
    slots.clear();
}

// short description of a value, for logging how functions get called
export function shape(value: any): string {
    try {
        if (value == null) return String(value);
        if (typeof value !== "object") return `${typeof value}:${String(value).slice(0, 24)}`;
        return `{${Object.keys(value).slice(0, 12).join(",")}}`;
    } catch {
        return "?";
    }
}
