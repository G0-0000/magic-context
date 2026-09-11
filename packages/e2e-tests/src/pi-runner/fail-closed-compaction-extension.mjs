import { registerPiFailClosedSurface } from "../../../pi-plugin/src/fail-closed-pi.ts";

export default function registerRecoveredFailClosedCompactionHook(pi) {
  const recoveredDb = {};
  const surface = registerPiFailClosedSurface(pi, {
    reason: { kind: "storage_failure", cause: "e2e recovered listener fixture" },
    tryReopen: async () => recoveredDb,
    onRecovered: async () => {},
    report: () => {},
  });

  pi.registerCommand("e2e-recover-fail-closed", {
    description: "Recover the fail-closed compact-hook composition fixture",
    async handler() {
      const recovered = await surface.adoptRecovered(recoveredDb);
      if (!recovered) throw new Error("fail-closed fixture did not recover");
    },
  });
}
