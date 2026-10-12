import {
	hasPiFallbackMessageTags as readMessageTags,
	hasPiFallbackToolOwnerTags as readToolOwnerTags,
} from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readPiFallbackTagRows } from "./tag-snapshot-pi";

/**
 * Answer a `pi-msg-*` existence probe from the session's fallback rows, which
 * the tag snapshot keeps current from changed tag numbers. A pass that only
 * appends tags therefore never rescans the session's tags with LIKE. Inside a
 * transaction those rows are unavailable and the probe queries the table.
 */
function probe(
	db: Database,
	sessionId: string,
	kind: "message" | "tool",
): boolean {
	const rows = readPiFallbackTagRows(db, sessionId);
	if (!rows)
		return kind === "message"
			? readMessageTags(db, sessionId)
			: readToolOwnerTags(db, sessionId);
	return rows.some((row) => row.type === kind);
}

export function hasPiFallbackMessageTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "message");
}

export function hasPiFallbackToolOwnerTags(
	db: Database,
	sessionId: string,
): boolean {
	return probe(db, sessionId, "tool");
}
