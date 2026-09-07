import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";

export function getOpenCodeDatabasePath(): string {
    return resolveOpenCodeDbPath().path;
}

/** Match Pi's platform-specific project-directory encoding for session folders. */
export function projectPathToPiSessionSlug(
    projectPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const separators = platform === "win32" ? /[:\\/]+/g : /\/+/g;
    const trimmed = projectPath.replace(/^[\\/]+|[\\/]+$/g, "");
    const slug = trimmed.replace(separators, "-");
    return `--${slug}--`;
}
