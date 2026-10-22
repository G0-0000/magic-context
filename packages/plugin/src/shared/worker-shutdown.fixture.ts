// Worker for worker-shutdown.test.ts. "cooperative" closes its connection
// when asked; "deaf" never reads parent messages, so only terminate() stops it.
import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { exitOnWorkerClose } from "./worker-shutdown";

const { path, mode } = workerData as { path: string; mode: "cooperative" | "deaf" };
const db = new Database(path);
db.prepare("SELECT 1").get();
if (mode === "cooperative") exitOnWorkerClose(parentPort, () => db.close());
// Keep the thread alive until it is asked to close or is terminated.
setInterval(() => {}, 1_000);
parentPort?.postMessage("ready");
