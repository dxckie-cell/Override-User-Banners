// tag added to all print statements to help with debugging with logcat on adb
const TAG = "[custom-banners]";

// what happened on load, shown at the bottom of the settings screen
export const statusLines: string[] = [];

export function status(message: string): void {
    statusLines.push(message);
    try {
        console.log(`${TAG} ${message}`);
    } catch {
        // logging must never break the plugin
    }
}

export function resetStatus(): void {
    statusLines.length = 0;
}
