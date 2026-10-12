import {
	TAG_INSERT_CONFLICT_ROWS,
	tagRevisionCountSql,
	tagRevisionIncarnationSql,
	tagRevisionKey,
} from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	getTagsByNumbers,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Connection-local tag revisions avoid invalidating snapshots for unrelated metadata writes. */
export function createPiTagSnapshotReader(db: Database) {
	const existing = readers.get(db);
	if (existing) return existing;
	// Replace the pi_tag_insert/update/delete TEMP triggers when an extension
	// reload keeps its SQLite connection: older definitions tracked only a
	// revision, not the changed tag numbers needed to update cached rows.
	// An outer write's conflict policy can override OR IGNORE inside a trigger,
	// so journal inserts explicitly exclude keys already present.
	// REPLACE's implicit deletes may skip DELETE triggers. Before insertion,
	// record conflicting rows' old sessions/numbers and the same write counts
	// as the shared revision observer.
	db.exec(`
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_revision (revision INTEGER NOT NULL);
		INSERT INTO pi_tag_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM pi_tag_revision);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_session_revision (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_watch (session_id TEXT PRIMARY KEY);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_changes (session_id TEXT, tag_number INTEGER, PRIMARY KEY (session_id, tag_number));
		DROP TRIGGER IF EXISTS temp.pi_tag_insert;
		DROP TRIGGER IF EXISTS temp.pi_tag_update;
		DROP TRIGGER IF EXISTS temp.pi_tag_delete;
		DROP TRIGGER IF EXISTS temp.pi_tag_insert_conflicts;
		CREATE TEMP TRIGGER pi_tag_insert_conflicts BEFORE INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + (SELECT COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}));
			INSERT INTO pi_tag_session_revision
				SELECT session_id, COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}) GROUP BY session_id
				ON CONFLICT(session_id) DO UPDATE SET revision = revision + excluded.revision;
			INSERT INTO pi_tag_changes
				SELECT session_id, tag_number FROM (${TAG_INSERT_CONFLICT_ROWS}) AS conflicts
				WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = conflicts.session_id)
				AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = conflicts.session_id AND tag_number = conflicts.tag_number)
				GROUP BY session_id, tag_number;
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_insert AFTER INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (NEW.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_update AFTER UPDATE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision SELECT NEW.session_id, 1 WHERE NEW.session_id IS NOT OLD.session_id ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_delete AFTER DELETE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
		END;
	`);
	const revision = db.prepare(`WITH stamp AS (SELECT
		COALESCE((SELECT revision FROM pi_tag_session_revision WHERE session_id = ?), 0) AS own,
		COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS total)
		SELECT CAST(own AS TEXT) AS local,
		(${tagRevisionIncarnationSql("total")}) || ':' || CAST(${tagRevisionCountSql("total")} - own AS TEXT) AS foreign_revision FROM stamp`);
	revisionReaders.set(db, (sessionId) => {
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		const row = revision.get(sessionId, tagRevisionKey(sessionId)) as {
			local: string;
			foreign_revision: string;
		};
		return [row.local, row.foreign_revision] as const;
	});
	const changed = db.prepare(
		"SELECT tag_number FROM pi_tag_changes WHERE session_id = ? ORDER BY tag_number",
	);
	const clearChanged = db.prepare(
		"DELETE FROM pi_tag_changes WHERE session_id = ?",
	);
	const watch = db.prepare("INSERT OR IGNORE INTO pi_tag_watch VALUES (?)");
	const unwatch = db.prepare("DELETE FROM pi_tag_watch WHERE session_id = ?");
	const cache = new Map<
		string,
		{
			revision: string;
			foreignRevision: string;
			tags: ReturnType<typeof getTagsBySession>;
		}
	>();
	const read = (
		sessionId: string,
		borrowed = false,
	): ReturnType<typeof getTagsBySession> => {
		// Do not publish or consume journal entries inside a transaction: its
		// rows may roll back while the in-memory snapshot cannot roll back.
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction)
			return getTagsBySession(db, sessionId);
		// Subtract this connection's writes from the shared session counter. Both
		// counters roll back with the rows; unrelated foreign commits do not matter.
		const [local, external] = revisionReaders.get(db)?.(sessionId) ?? [
			"0",
			"0:0",
		];
		let snapshot = cache.get(sessionId);
		if (!snapshot || snapshot.foreignRevision !== external) {
			snapshot = {
				revision: local,
				foreignRevision: external,
				tags: getTagsBySession(db, sessionId),
			};
			if (cache.size >= 100 && !cache.has(sessionId)) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) {
					cache.delete(oldest);
					unwatch.run(oldest);
					clearChanged.run(oldest);
				}
			}
			cache.set(sessionId, snapshot);
			for (const tag of snapshot.tags) Object.freeze(tag);
			watch.run(sessionId);
		} else if (snapshot.revision !== local) {
			const numbers = (changed.all(sessionId) as { tag_number: number }[]).map(
				(row) => row.tag_number,
			);
			if (numbers.length > 0) {
				const dirty = new Set(numbers);
				const replacements = getTagsByNumbers(db, sessionId, numbers);
				for (const tag of replacements) Object.freeze(tag);
				const highest = snapshot.tags.at(-1)?.tagNumber ?? -1;
				if (numbers.every((number) => number > highest)) {
					// Ordinary appends already have canonical order. Do not filter or
					// merge the historical prefix just to add a few new rows.
					snapshot.tags = [...snapshot.tags, ...replacements];
				} else {
					const unchanged = snapshot.tags.filter(
						(tag) => !dirty.has(tag.tagNumber),
					);
					// Both inputs use the authoritative tag_number/id order, including
					// duplicate tag numbers in legacy stores. Merge without re-sorting history.
					const merged: typeof unchanged = [];
					let index = 0;
					for (const tag of unchanged) {
						while (index < replacements.length) {
							const next = replacements[index];
							if (!next) break;
							if (
								next.tagNumber > tag.tagNumber ||
								(next.tagNumber === tag.tagNumber &&
									(next.id ?? 0) > (tag.id ?? 0))
							)
								break;
							merged.push(next);
							index += 1;
						}
						merged.push(tag);
					}
					merged.push(...replacements.slice(index));
					snapshot.tags = merged;
				}
			}
			snapshot.revision = local;
		}
		clearChanged.run(sessionId);
		// Heuristics can edit their working entries; never expose the cached objects.
		return borrowed ? snapshot.tags : snapshot.tags.map((tag) => ({ ...tag }));
	};
	readers.set(db, read);
	return read;
}

const readers = new WeakMap<
	Database,
	(sessionId: string, borrowed?: boolean) => ReturnType<typeof getTagsBySession>
>();

const revisionReaders = new WeakMap<
	Database,
	(sessionId: string) => readonly [string, string] | null
>();

/** Revision for tag-only observations; transactions must use uncached reads. */
export function readPiTagSnapshotRevision(
	db: Database,
	sessionId: string,
): readonly [string, string] | null {
	if (!readers.has(db)) createPiTagSnapshotReader(db);
	return revisionReaders.get(db)?.(sessionId) ?? null;
}

export function getPiTagSnapshot(db: Database, sessionId: string) {
	let reader = readers.get(db);
	if (!reader) {
		reader = createPiTagSnapshotReader(db);
		readers.set(db, reader);
	}
	return reader(sessionId);
}

/** Internal read-only projection. Changed rows get new objects; unchanged rows retain identity. */
export function getPiTagSnapshotView(db: Database, sessionId: string) {
	return createPiTagSnapshotReader(db)(sessionId, true);
}
