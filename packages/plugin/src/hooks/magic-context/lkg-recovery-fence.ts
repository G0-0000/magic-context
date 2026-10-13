import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";
import { withStorageFileMutex } from "../../shared/storage-file-mutex";
import {
    syncStorageDirectorySync,
    writeStorageFileDurableAtomicSync,
} from "../../shared/storage-permissions";
import type { LkgSlot } from "./lkg-slot";

interface Fence {
    version: 1;
    sessionId: string;
    host: string;
    modelKey: string | null;
    providerKey: string | null;
    slotKey: string;
    servedDigest: string;
    revision: string;
    state: "clean" | "dirty";
    checksum: string;
}
export class LkgRecoveryFenceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LkgRecoveryFenceError";
    }
}
let platform: NodeJS.Platform = process.platform;
let observer: ((phase: "dirty" | "committed" | "temp-synced" | "clean") => void) | undefined;

// Node has no proven Windows directory-fsync primitive. Never trust a restart
// certificate there: retain process-local BUSY replay, then refuse after restart
// until a healthy rebuild. No best-effort dirty or clean files are published.
const durableFencesSupported = () => platform !== "win32";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const lkgServedArrayDigest = hash;
export function lkgRecoveryFencePath(sessionId: string): string {
    return join(getMagicContextStorageDir(), "lkg-recovery-fences", `${hash(sessionId)}.json`);
}
function metadata(slot: LkgSlot) {
    return [
        slot.inputIdSeq,
        slot.inputContentDigests,
        slot.inputContentSignatures ?? null,
        slot.piOutputEntryIds ?? null,
        slot.lastInputMessageId,
        slot.modelKey,
        slot.providerKey,
    ];
}
function representationKey(slot: LkgSlot): string {
    return createHash("sha256")
        .update(slot.jsonPrefix)
        .update(JSON.stringify(metadata(slot)))
        .digest("hex");
}
export function lkgRecoverySlotKey(slot: LkgSlot): string {
    return hash(
        JSON.stringify([
            representationKey(slot),
            slot.capturedAt,
            slot.rowVersion ?? null,
            slot.captureSequence ?? null,
        ]),
    );
}
function payload(record: Omit<Fence, "checksum">) {
    return [
        record.version,
        record.sessionId,
        record.host,
        record.modelKey,
        record.providerKey,
        record.slotKey,
        record.servedDigest,
        record.revision,
        record.state,
    ];
}
function publishRecord(record: Omit<Fence, "checksum">): void {
    try {
        writeStorageFileDurableAtomicSync(
            lkgRecoveryFencePath(record.sessionId),
            JSON.stringify({ ...record, checksum: hash(JSON.stringify(payload(record))) }),
            () => observer?.("temp-synced"),
        );
        observer?.(record.state);
    } catch (error) {
        const visible = read(record.sessionId);
        if (
            record.state === "clean" &&
            visible?.state === "clean" &&
            visible.revision === record.revision &&
            visible.slotKey === record.slotKey
        ) {
            rmSync(lkgRecoveryFencePath(record.sessionId), { force: true });
            syncStorageDirectorySync(dirname(lkgRecoveryFencePath(record.sessionId)));
        }
        throw error;
    }
}
function read(sessionId: string): Fence | null {
    try {
        const path = lkgRecoveryFencePath(sessionId);
        const stat = lstatSync(path);
        const directory = lstatSync(dirname(path));
        if (
            !stat.isFile() ||
            stat.size > 4096 ||
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            (process.platform !== "win32" &&
                ((stat.mode & 0o077) !== 0 ||
                    (directory.mode & 0o077) !== 0 ||
                    (process.getuid && stat.uid !== process.getuid())))
        )
            return null;
        const value = JSON.parse(readFileSync(path, "utf8")) as Fence;
        if (
            value.version !== 1 ||
            value.sessionId !== sessionId ||
            value.host !== getHarness() ||
            (value.modelKey !== null && typeof value.modelKey !== "string") ||
            (value.providerKey !== null && typeof value.providerKey !== "string") ||
            !/^[a-f0-9]{64}$/.test(value.slotKey) ||
            !/^[a-f0-9]{64}$/.test(value.servedDigest) ||
            typeof value.revision !== "string" ||
            !["clean", "dirty"].includes(value.state) ||
            value.checksum !== hash(JSON.stringify(payload(value)))
        )
            return null;
        return value;
    } catch {
        return null;
    }
}
function matches(record: Fence | null, slot: LkgSlot): record is Fence {
    return (
        !!record &&
        record.slotKey === lkgRecoverySlotKey(slot) &&
        record.modelKey === slot.modelKey &&
        record.providerKey === slot.providerKey
    );
}
function publish(sessionId: string, slot: LkgSlot, state: Fence["state"], revision: string): void {
    const record: Omit<Fence, "checksum"> = {
        version: 1,
        sessionId,
        host: getHarness(),
        modelKey: slot.modelKey,
        providerKey: slot.providerKey,
        slotKey: lkgRecoverySlotKey(slot),
        servedDigest: hash(slot.jsonPrefix),
        revision,
        state,
    };
    publishRecord(record);
}
function locked<T>(sessionId: string, work: () => T): T {
    return withStorageFileMutex(`${lkgRecoveryFencePath(sessionId)}.locks`, () => {
        const path = lkgRecoveryFencePath(sessionId);
        for (const name of readdirSync(dirname(path))) {
            if (name.startsWith(`${basename(path)}.`) && name.endsWith(".tmp"))
                rmSync(join(dirname(path), name), { force: true });
        }
        return work();
    });
}

/** Only a matching durable certificate can authorize a process-cold replay. */
export function hasCleanLkgRecoveryFence(sessionId: string, slot: LkgSlot): boolean {
    if (!durableFencesSupported()) return false;
    const record = read(sessionId);
    return matches(record, slot) && record.state === "clean";
}
export function lkgFenceRequiresRebuild(
    sessionId: string,
    slot: LkgSlot,
    processLocalProof: boolean,
): boolean {
    return durableFencesSupported()
        ? !hasCleanLkgRecoveryFence(sessionId, slot)
        : !processLocalProof;
}
export function dirtyLkgRecoveryRevision(sessionId: string, slot: LkgSlot): string | undefined {
    if (!durableFencesSupported()) return undefined;
    const record = read(sessionId);
    return matches(record, slot) && record.state === "dirty" ? record.revision : undefined;
}
export function ownsLkgDirtyFence(sessionId: string, revision: string | undefined): boolean {
    if (!durableFencesSupported()) return revision === "process-local";
    const record = read(sessionId);
    return revision !== undefined && record?.state === "dirty" && record.revision === revision;
}

/** An uncaptured output must not leave an older request certified as current. */
export function invalidateCleanLkgRecoveryFence(
    sessionId: string,
    load: () => LkgSlot | undefined,
    ownRevision?: string,
): string | undefined {
    if (!durableFencesSupported()) return "process-local";
    return locked(sessionId, () => {
        const slot = load();
        const record = read(sessionId);
        if (slot && matches(record, slot) && record.state === "clean") {
            const revision = randomUUID();
            publish(sessionId, slot, "dirty", revision);
            return revision;
        }
        return record?.state === "dirty" && record.revision === ownRevision
            ? ownRevision
            : undefined;
    });
}

/** Reserve an uncertified healthy output without needing the busy SQLite writer. */
export function prepareLkgCaptureFence(args: {
    sessionId: string;
    slot: LkgSlot;
    previousSlot?: LkgSlot;
    ownDirtyRevision?: string;
    rebuild?: boolean;
}): string {
    if (!durableFencesSupported()) return "process-local";
    return locked(args.sessionId, () => {
        const before = read(args.sessionId);
        const owns = before?.state === "dirty" && before.revision === args.ownDirtyRevision;
        const unchangedBytes =
            before?.state === "clean" && before.servedDigest === hash(args.slot.jsonPrefix);
        if (
            !args.rebuild &&
            before &&
            !owns &&
            !unchangedBytes &&
            (!args.previousSlot || !matches(before, args.previousSlot) || before.state !== "clean")
        )
            throw new LkgRecoveryFenceError(
                `A concurrent recovery requires a declared prefix rebuild (state=${before?.state}, owned=${owns}, previous=${!!args.previousSlot}, bytes=${unchangedBytes})`,
            );
        if (!args.rebuild && !before && args.previousSlot)
            throw new LkgRecoveryFenceError("Unproven prior request requires a prefix rebuild");
        const revision = randomUUID();
        if (before) publishRecord({ ...before, state: "dirty", revision });
        else publish(args.sessionId, args.previousSlot ?? args.slot, "dirty", revision);
        return revision;
    });
}

/** Complete a previously committed capture only if no later publisher superseded it. */
export function certifyCommittedLkgCapture(args: {
    sessionId: string;
    slot: LkgSlot;
    revision: string;
    latestServedDigest: string;
    load: () => LkgSlot | undefined;
}): boolean {
    if (!durableFencesSupported()) return false;
    return locked(args.sessionId, () => {
        const before = read(args.sessionId);
        if (before?.state !== "dirty" || before.revision !== args.revision) return false;
        const saved = args.load();
        if (
            !saved ||
            representationKey(saved) !== representationKey(args.slot) ||
            hash(saved.jsonPrefix) !== args.latestServedDigest
        )
            return false;
        publish(args.sessionId, saved, "clean", args.revision);
        return true;
    });
}

/** Mark dirty before the caller can hand recovery bytes back to its host. */
export function markLkgRecoveryDirty(args: {
    sessionId: string;
    slot: LkgSlot;
    ownDirtyRevision?: string;
    processLocalProof: boolean;
}): string {
    if (!durableFencesSupported()) {
        if (!args.processLocalProof)
            throw new LkgRecoveryFenceError("Restart replay requires a healthy rebuild on Windows");
        return "process-local";
    }
    return locked(args.sessionId, () => {
        const slot = args.slot;
        const before = read(args.sessionId);
        const known = matches(before, slot);
        if (before?.state === "dirty") {
            if (!args.processLocalProof || before.revision !== args.ownDirtyRevision)
                throw new LkgRecoveryFenceError(
                    `Recovery superseded this process's last-good request (local=${args.processLocalProof}, owned=${before.revision === args.ownDirtyRevision})`,
                );
            return before.revision;
        }
        if (!known || before?.state !== "clean")
            throw new LkgRecoveryFenceError("No clean durable recovery certificate");
        const revision = randomUUID();
        publish(args.sessionId, slot, "dirty", revision);
        return revision;
    });
}

/** Serialize the SQLite commit and certificate publication with BUSY returns. */
export function commitLkgWithRecoveryFence(args: {
    sessionId: string;
    slot: LkgSlot;
    load: () => LkgSlot | undefined;
    commit: () => boolean;
    rebuild?: boolean;
    retainDirtyRevision?: string;
    ownDirtyRevision?: string;
    requiredRevision?: string;
    cleanDigest?: string;
    unchanged?: boolean;
}): boolean {
    if (!durableFencesSupported()) return args.commit();
    return locked(args.sessionId, () => {
        const current = args.load();
        const before = read(args.sessionId);
        if (args.requiredRevision && before?.revision !== args.requiredRevision)
            throw new LkgRecoveryFenceError("A later publisher superseded the rollback snapshot");
        const ownsDirty =
            before?.state === "dirty" &&
            (before.revision === args.retainDirtyRevision ||
                before.revision === args.ownDirtyRevision);
        if (
            current &&
            (!matches(before, current) || before.state === "dirty") &&
            !ownsDirty &&
            !args.rebuild
        )
            throw new LkgRecoveryFenceError(
                "A concurrent recovery requires a declared prefix rebuild",
            );
        if (
            args.unchanged &&
            current &&
            matches(before, current) &&
            before.state === "clean" &&
            representationKey(current) === representationKey(args.slot)
        ) {
            if (!args.commit()) return false;
            const saved = args.load();
            if (saved && matches(before, saved)) return true;
            throw new LkgRecoveryFenceError(
                "An unchanged commit unexpectedly replaced its certified generation",
            );
        }
        publish(
            args.sessionId,
            current ?? args.slot,
            "dirty",
            ownsDirty ? before.revision : randomUUID(),
        );
        if (!args.commit()) return false;
        observer?.("committed");
        const saved = args.load();
        if (!saved || representationKey(saved) !== representationKey(args.slot))
            throw new LkgRecoveryFenceError("Last-good commit did not match its certificate");
        const cleanMatches =
            args.cleanDigest === undefined || hash(saved.jsonPrefix) === args.cleanDigest;
        publish(
            args.sessionId,
            saved,
            args.retainDirtyRevision || !cleanMatches ? "dirty" : "clean",
            ownsDirty ? before.revision : randomUUID(),
        );
        return true;
    });
}

export function clearLkgRecoveryFence<T = void>(
    sessionId: string,
    remove?: () => T,
    shouldClear?: (value: T | undefined) => boolean,
): T | undefined {
    if (!durableFencesSupported()) return remove?.();
    return locked(sessionId, () => {
        const result = remove?.();
        if (shouldClear && !shouldClear(result)) return result;
        rmSync(lkgRecoveryFencePath(sessionId), { force: true });
        syncStorageDirectorySync(dirname(lkgRecoveryFencePath(sessionId)));
        return result;
    });
}
export const __test = {
    setPlatform(value: NodeJS.Platform) {
        const prior = platform;
        platform = value;
        return () => {
            platform = prior;
        };
    },
    setObserver(value: typeof observer) {
        observer = value;
        return () => {
            observer = undefined;
        };
    },
};
