import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export interface CtxExpandArgs extends ImitatedReducedArgs {
    tag?: number | string;
    start?: number;
    end?: number;
    /** Verbose range view: each message + tool call shown separately, with ordinals. */
    verbose?: boolean;
    /** Full untruncated recovery of one message (any role) by its ordinal. */
    message?: number;
    /**
     * Full sessionId of another session in the same project to expand (from a
     * cross-session ctx_search hit). Omit it — or pass this session's own id —
     * to expand the current session. Cross-session expands read the search
     * archive (indexed text only) and support only message/start/end.
     */
    sessionId?: string;
}
