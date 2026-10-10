// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[custom-banners]";

// kept in memory so the plugin settings screen can show what happened on load,
// since console output does not always reach the in-app log viewer
export const debugLines: string[] = [];

export function debug(message: string): void {
    debugLines.push(message);
    if (debugLines.length > 80) debugLines.shift();
    try {
        console.log(`${TAG} ${message}`);
    } catch {
        // logging must never break the plugin
    }
}
