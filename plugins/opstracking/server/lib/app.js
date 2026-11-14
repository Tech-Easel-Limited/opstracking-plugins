export const GENERIC_APP = "AI assistant";
/** The label for a client's self-reported name; anything unrecognised is a generic assistant. */
export function appFromClientName(name) {
    const n = (name ?? "").toLowerCase();
    if (n.includes("cursor"))
        return "Cursor";
    if (n.includes("claude"))
        return "Claude";
    return GENERIC_APP;
}
export function appSlug(app) {
    if (app === "Claude")
        return "claude";
    if (app === "Cursor")
        return "cursor";
    return undefined;
}
/** `--app claude|cursor` on the command line, as a label. */
export function appFromSlug(slug) {
    const s = slug.trim().toLowerCase();
    if (s === "claude")
        return "Claude";
    if (s === "cursor")
        return "Cursor";
    return undefined;
}
/** The app as a sentence names it: "Cursor", or "your AI assistant". */
export function appNoun(app) {
    return app && app !== GENERIC_APP ? app : "your AI assistant";
}
/** The plugin's setup command as this app spells it. */
export function setupCommand(app) {
    if (app === "Claude")
        return "/opstracking:setup";
    if (app === "Cursor")
        return "/opstracking-setup";
    return "the OpsTracking setup command";
}
