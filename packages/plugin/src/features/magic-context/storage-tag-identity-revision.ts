import type { Database } from "../../shared/sqlite";

/**
 * Per-session revision of the `tags` columns that identify a tag or carry its
 * reasoning estimate: `id`, `session_id`, `message_id`, `tag_number`, `type`,
 * `tool_owner_message_id` and `reasoning_token_count`.
 *
 * Caches built from those columns (the tag owner summary in storage-tags.ts)
 * can then tell, after another connection's commit, whether that commit
 * rewrote any of them for a session, without rereading the session's tags.
 * Status, drop-mode, size and token-count writes leave it alone.
 *
 * It lives in `schema_migrations_meta`, the key/value table that already holds
 * per-session `retrospective_activity:<session>` rows, so no schema change is
 * needed. The value only ever grows. Deletes are not counted: they change the
 * session's tag count, which the cache checks separately.
 */
export const TAG_IDENTITY_REVISION_PREFIX = "tag_identity_revision:";
export const TAG_REVISION_PREFIX = "tag_revision:";
export const TAG_TOMBSTONE_OWNER_PREFIX = "tag_revision_owner:";

/** JSON quoting keeps session IDs containing separators in their own key range. */
export function tagTombstoneOwnerRange(sessionId: string): readonly [string, string] {
    const stem = `${TAG_TOMBSTONE_OWNER_PREFIX}${JSON.stringify(sessionId)}`;
    return [`${stem}:`, `${stem};`];
}

export function tagTombstoneOwnerKey(sessionId: string, harness: string): string {
    return `${tagTombstoneOwnerRange(sessionId)[0]}${harness}`;
}

/** Full-row revision for caches that also serve status, size and reduction fields. */
export function tagRevisionKey(sessionId: string): string {
    return `${TAG_REVISION_PREFIX}${sessionId}`;
}

export function tagIdentityRevisionKey(sessionId: string): string {
    return `${TAG_IDENTITY_REVISION_PREFIX}${sessionId}`;
}

const BUMP = (
    session: string,
    prefix = TAG_IDENTITY_REVISION_PREFIX,
) => `INSERT INTO schema_migrations_meta (key, value)
        VALUES ('${prefix}' || ${session}, '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`;

/** Rows an INSERT can replace through the tag table's primary or unique keys.
 * Separate indexed probes avoid an OR predicate turning ordinary appends into a table scan.
 * UNION counts a row once when it conflicts through more than one key.
 */
export const TAG_INSERT_CONFLICT_ROWS = `SELECT id, session_id, tag_number FROM tags WHERE id = NEW.id
    UNION SELECT id, session_id, tag_number FROM tags WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number
    UNION SELECT id, session_id, tag_number FROM tags
        WHERE NEW.type = 'tool' AND NEW.tool_owner_message_id IS NOT NULL
          AND type = 'tool' AND tool_owner_message_id IS NOT NULL
          AND session_id = NEW.session_id AND message_id = NEW.message_id
          AND tool_owner_message_id = NEW.tool_owner_message_id`;

const BUMP_INSERT_CONFLICTS = (prefix: string) => `INSERT INTO schema_migrations_meta (key, value)
    SELECT '${prefix}' || session_id, CAST(COUNT(*) AS TEXT)
    FROM (${TAG_INSERT_CONFLICT_ROWS}) GROUP BY session_id
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)`;

/**
 * A TEMP trigger exists only on the connection that creates it and is not part
 * of the stored schema, so every Magic Context connection that can write tags
 * installs it when it opens (from `initializeDatabase`). It runs inside the
 * writing statement, so the bump commits or rolls back with the write itself.
 * It counts updates to id, session_id, message_id, tag_number, type,
 * tool_owner_message_id and reasoning_token_count, including upsert updates.
 * Ordinary inserts/deletes change the row count/highest ID that owner-summary
 * caches check instead. Conflicting inserts also bump before writing:
 * REPLACE can delete an existing row without firing DELETE triggers, and an
 * upsert may instead update it. Writes from connections that never ran
 * `initializeDatabase` (another tool editing the file directly) are not counted.
 */
const TRIGGER_SQL = `CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_identity_revision_au
    AFTER UPDATE OF id, session_id, message_id, tag_number, type, tool_owner_message_id, reasoning_token_count
    ON main.tags
    BEGIN
        ${BUMP("OLD.session_id")};
        INSERT INTO schema_migrations_meta (key, value)
            SELECT '${TAG_IDENTITY_REVISION_PREFIX}' || NEW.session_id, '1'
            WHERE NEW.session_id IS NOT OLD.session_id
            ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END`;

export function installTagIdentityRevisionTrigger(db: Database): void {
    db.exec(TRIGGER_SQL);
    // Record existing rows that INSERT might replace without enabling recursive
    // triggers on unrelated tables. A bump for an ignored insert/upsert may
    // cause an extra cache read, but cannot hide a real change, and rolls back
    // with the statement. Also advance the old session's tags_version: the
    // durable INSERT trigger only advances the destination session, while
    // assignment and replay caches may still hold the displaced row.
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_revision_bi BEFORE INSERT ON main.tags BEGIN
        ${BUMP_INSERT_CONFLICTS(TAG_REVISION_PREFIX)};
        ${BUMP_INSERT_CONFLICTS(TAG_IDENTITY_REVISION_PREFIX)};
        UPDATE session_meta SET tags_version = tags_version + 1
            WHERE session_id IN (SELECT session_id FROM (${TAG_INSERT_CONFLICT_ROWS}));
    END;`);
    // Keep the owner-summary counter selective. A full tag snapshot needs a
    // separate value in the same KV table, bumped atomically by every tag write.
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_revision_ai AFTER INSERT ON main.tags BEGIN
        ${BUMP("NEW.session_id", TAG_REVISION_PREFIX)};
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_revision_au AFTER UPDATE ON main.tags BEGIN
        ${BUMP("OLD.session_id", TAG_REVISION_PREFIX)};
        INSERT INTO schema_migrations_meta (key, value)
            SELECT '${TAG_REVISION_PREFIX}' || NEW.session_id, '1'
            WHERE NEW.session_id IS NOT OLD.session_id
            ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_revision_ad AFTER DELETE ON main.tags BEGIN
        ${BUMP("OLD.session_id", TAG_REVISION_PREFIX)};
    END;`);
}

/**
 * Advance the per-session identity-change counter when context data is reset.
 * Keep its value across reset/reimport: a reader may never observe the empty
 * table, and an import can reuse both primary IDs and tag numbers. Tag deletions
 * advance the separate full-row counter; this bump also invalidates cached tag
 * owners and assignments when only one harness's rows were removed. The legacy
 * function name remains for callers, but permanent deletion cleans these keys
 * separately after no producing harness remains.
 */
export function deleteTagIdentityRevisions(db: Database, sessionIds: readonly string[]): void {
    const statement = db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    );
    for (const sessionId of sessionIds) {
        statement.run(tagIdentityRevisionKey(sessionId));
    }
}
