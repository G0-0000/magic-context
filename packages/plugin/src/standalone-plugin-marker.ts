const markerSymbol = Symbol.for("cortexkit.standalone-plugins");

let failureLogged = false;

/** Announce this plugin without interfering with other standalone products. */
export function registerStandalonePluginMarker(version: string): void {
    try {
        const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
        let registry = globals[markerSymbol];
        if (registry === undefined) {
            registry = new Map<string, { version: string }>();
            globals[markerSymbol] = registry;
        }
        (registry as Map<string, { version: string }>).set("magic-context", {
            version,
        });
    } catch (error) {
        if (failureLogged) return;
        failureLogged = true;
        try {
            console.warn("[magic-context] Could not register standalone plugin marker", error);
        } catch {
            // Marker registration must never prevent the host from loading the plugin.
        }
    }
}
