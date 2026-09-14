import type { Database } from "../../../shared/sqlite";
import { normalizeStoredProjectPath, storedPathBelongsToIdentity } from "../project-identity";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    storedPathBelongsToWorkspace,
} from "../workspaces";
import type { Memory } from "./types";

/**
 * Read-visibility predicate for memory rows, shared between tool execution
 * and transform-time surfacing (e.g. Pi's task-requested memory injection).
 *
 * This is a NARROW extraction of the `memoryVisibleToTool` closure that used
 * to live inline in `tools/ctx-memory/tools.ts` — the predicate body is
 * byte-for-byte the same logic, so tool read behavior is unchanged. What the
 * filter encodes (and what it deliberately does NOT encode):
 *
 *   - Workspace membership: a memory stored under any identity of the
 *     caller's workspace identity set (after alias expansion) is a candidate.
 *   - Own vs foreign: memories owned by the caller's project identity are
 *     visible in every category; foreign workspace memories are visible only
 *     when they are active-or-permanent, unexpired, shareable, scoped
 *     project/ecosystem/universe, AND in a workspace-shared category.
 *
 * Status / expiry are only enforced here for FOREIGN memories (matching the
 * original tool contract). Callers that need an injection-eligibility layer
 * over own-project memories (e.g. archived or expired own memories must not
 * be injected) must apply that check separately — see
 * `isInjectableMemory` in the Pi `subagent-inject-pi.ts` module.
 */
export type MemoryVisibilityFilter = (memory: Memory) => boolean;

export function createMemoryVisibilityFilter(
    db: Database,
    projectPath: string,
): MemoryVisibilityFilter {
    const workspaceIdentitySet = resolveWorkspaceIdentitySet(db, projectPath);
    const expandedWorkspace = expandWorkspaceIdentitySetWithAliases(
        db,
        workspaceIdentitySet.identities,
    );
    const workspaceVisibleIdentities =
        workspaceIdentitySet.identities.length > 1
            ? expandedWorkspace.expandedIdentities
            : workspaceIdentitySet.identities;
    const targetIdentityForStoredPath = (rawProjectPath: string) =>
        workspaceIdentitySet.identities.length > 1
            ? (resolveStoredPathWorkspaceIdentity(
                  rawProjectPath,
                  workspaceIdentitySet.identities,
                  expandedWorkspace.canonicalIdentityByStoredPath,
              ) ?? normalizeStoredProjectPath(rawProjectPath))
            : normalizeStoredProjectPath(rawProjectPath);
    // The workspace's share-category policy matches the render path.
    // null means there is no workspace filter; a workspaced caller gets
    // an explicit list where [] shares no foreign categories.
    const shareCategories =
        workspaceIdentitySet.identities.length > 1
            ? resolveWorkspaceShareCategories(db, projectPath)
            : null;

    return (memory: Memory): boolean => {
        if (workspaceIdentitySet.identities.length <= 1) {
            return storedPathBelongsToIdentity(memory.projectPath, projectPath);
        }
        if (
            !storedPathBelongsToWorkspace(
                memory.projectPath,
                workspaceIdentitySet.identities,
                workspaceVisibleIdentities,
                expandedWorkspace.canonicalIdentityByStoredPath,
            )
        ) {
            return false;
        }
        const isOwn = targetIdentityForStoredPath(memory.projectPath) === projectPath;
        if (isOwn) return true;
        return (
            (memory.status === "active" || memory.status === "permanent") &&
            (memory.expiresAt === null || memory.expiresAt > Date.now()) &&
            memory.shareable === 1 &&
            ["project", "ecosystem", "universe"].includes(memory.scope) &&
            (shareCategories?.includes(memory.category) ?? false)
        );
    };
}
