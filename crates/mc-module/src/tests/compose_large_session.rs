//! Synthetic large-session fixture for the HARD-fold `compose_m0m1` stage.
//!
//! A long-lived OpenCode session in Rust mode can carry thousands of compartments
//! (four paraphrase tiers each, with importance and dates) plus hundreds of project
//! memories. This file builds that shape in a throwaway temporary store, never a
//! copy of a real one, and drives real transform passes through it:
//!
//! - `large_session_compose_profile` (ignored, run by hand in release) prints the
//!   per-pass stage timings at a chosen scale.
//! - `large_session_compose_differential` replays a seeded randomized sequence of
//!   fold, SOFT and defer passes and requires every pass's served m0/m1 bytes to
//!   match the digests recorded from the implementation before the optimization
//!   (`testdata/compose-large-session-golden.txt`).

use super::tests::{item, memory_input, pctx, req, store};
use super::*;
use sha2::{Digest, Sha256};

/// A small deterministic generator (xorshift64*), so the fixture and the pass
/// sequence are identical on every machine and every run.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub(super) fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    pub(super) fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

const WORDS: &[&str] = &[
    "the", "module", "fold", "compartment", "historian", "boundary", "ordinal", "tail",
    "cache", "prefix", "store", "session", "memory", "render", "budget", "tier", "decay",
    "pressure", "anchor", "coverage", "transform", "pass", "frozen", "unit", "reduction",
    "tag", "overlay", "marker", "publish", "replay", "served", "bytes", "digest", "hash",
    "token", "estimate", "agent", "user", "asked", "fixed", "added", "removed", "renamed",
    "refactored", "tested", "verified", "reviewed", "merged", "branch", "commit", "worktree",
    "clippy", "cargo", "bun", "typecheck", "schema", "migration", "epoch", "lock", "writer",
    "reader", "sqlite", "row", "column", "index", "query", "plan", "latency", "ms", "MB",
    "error", "warning", "panic", "retry", "timeout", "deadline", "budget", "slack", "and",
    "or", "but", "because", "so", "then", "after", "before", "while", "when", "with",
    "without", "into", "from", "over", "under", "between", "across", "per", "each", "every",
    "OpenCode", "Pi", "Rust", "TypeScript", "Anthropic", "provider", "model", "thinking",
    "signature", "reasoning", "tool", "result", "call", "arc", "drop", "strip", "caveman",
    "todo", "note", "nudge", "profile", "mural", "docs", "AGENTS.md", "config", "jsonc",
    "path/to/file.rs", "crates/mc-module", "packages/plugin", "line", "42", "1,627", "3.2s",
    "v0.48.0", "#593", "<tag>", "a&b", "x>y", "café", "naïve", "日本語", "🙂",
];

fn words(rng: &mut Rng, count: usize) -> String {
    let mut out = String::new();
    for index in 0..count {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[rng.below(WORDS.len() as u64) as usize]);
    }
    out
}

/// Prose of roughly `target` bytes: sentences, some bullets, an occasional
/// heading-like line (the renderer must indent it) and blank-line paragraphs.
fn prose(rng: &mut Rng, target: usize) -> String {
    let mut out = String::new();
    while out.len() < target {
        if !out.is_empty() {
            out.push_str(match rng.below(10) {
                0 => "\n\n",
                1 | 2 => "\n- ",
                3 if rng.below(8) == 0 => "\n## ",
                _ => " ",
            });
        }
        let count = 6 + rng.below(14) as usize;
        let sentence = words(rng, count);
        let mut chars = sentence.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
        out.push('.');
    }
    out
}

fn date(day: u64) -> String {
    let month = 1 + (day / 28) % 12;
    let year = 2026 + day / (28 * 12);
    format!("{year:04}-{month:02}-{:02}", 1 + day % 28)
}

/// One stored compartment covering ordinals `start..=end`. Most rows are v2
/// four-tier rows; about one in twelve is a pre-v2 flat row, and a few carry
/// sparse tiers so the renderer's denser-tier fallback is exercised.
pub(super) fn compartment(rng: &mut Rng, sequence: i64, start: u64, end: u64) -> StoredCompartment {
    let legacy = rng.below(12) == 0;
    let size = 450 + rng.below(700) as usize;
    let p1 = prose(rng, size);
    let tiers = if legacy {
        [None, None, None, None]
    } else {
        let p2 = prose(rng, p1.len() * 45 / 100);
        let p3 = prose(rng, p1.len() / 5);
        let count = 4 + rng.below(8) as usize;
        let p4 = words(rng, count);
        match rng.below(20) {
            0 => [Some(p1.clone()), None, Some(p3), None],
            1 => [Some(p1.clone()), Some(p2), Some(p3), Some(String::new())],
            _ => [Some(p1.clone()), Some(p2), Some(p3), Some(p4)],
        }
    };
    let content = if legacy && rng.below(2) == 0 {
        format!("U: {}\n{p1}", words(rng, 8))
    } else {
        p1
    };
    let title_words = 4 + rng.below(6) as usize;
    let title = words(rng, title_words);
    let day = sequence as u64 / 3;
    let [p1, p2, p3, p4] = tiers;
    StoredCompartment {
        sequence,
        start_message: start as i64,
        end_message: end as i64,
        start_message_id: format!("m{start}#0"),
        end_message_id: format!("m{end}#0"),
        start_date: Some(date(day)),
        end_date: Some(date(day + rng.below(3))),
        title,
        content,
        p1,
        p2,
        p3,
        p4,
        importance: 1 + rng.below(100) as i32,
        episode_type: Some(["work", "decision", "debug"][rng.below(3) as usize].to_string()),
        legacy: i32::from(legacy),
        created_at: 1_780_000_000_000 + sequence * 60_000,
    }
}

const CATEGORIES: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];
pub(super) const PROJECT: &str = "git:large-session";
pub(super) const NOW_MS: i64 = 1_790_000_000_000;

pub(super) fn insert_memory(store: &McStore, rng: &mut Rng, now_ms: i64) {
    let category = CATEGORIES[rng.below(CATEGORIES.len() as u64) as usize];
    let size = 80 + rng.below(260) as usize;
    let content = prose(rng, size);
    let mut input = memory_input(PROJECT, category, &content, now_ms);
    input.importance = Some(1 + rng.below(100) as i32);
    store.insert_memory(input).unwrap();
}

/// The fixture's session: a store, the compartment cursor and the live array.
pub(super) struct LargeSession {
    pub(super) _dir: tempfile::TempDir,
    pub(super) store: McStore,
    pub(super) session: String,
    pub(super) messages_per_compartment: u64,
    pub(super) next_sequence: i64,
    /// Highest ordinal covered by a stored compartment.
    pub(super) covered_end: u64,
    pub(super) messages: Vec<CkIngressMessage>,
    pub(super) render_generation: u64,
    pub(super) rng: Rng,
}

impl LargeSession {
    /// `compartments` stored compartments of `messages_per_compartment` ordinals
    /// each, `memories` project memories, and a live array holding the last
    /// `live_covered` covered messages (the host trims older ones at its
    /// compaction marker) followed by `tail` uncovered messages.
    pub(super) fn new(
        seed: u64,
        compartments: usize,
        messages_per_compartment: u64,
        memories: usize,
        live_covered: u64,
        tail: u64,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut rng = Rng::new(seed);
        let session = format!("ses_large_{seed}");
        let rows = (0..compartments)
            .map(|index| {
                let start = index as u64 * messages_per_compartment + 1;
                compartment(
                    &mut rng,
                    index as i64 + 1,
                    start,
                    start + messages_per_compartment - 1,
                )
            })
            .collect::<Vec<_>>();
        store.replace_compartments(&session, &rows).unwrap();
        for index in 0..memories {
            insert_memory(&store, &mut rng, NOW_MS - 86_400_000 + index as i64);
        }
        let covered_end = compartments as u64 * messages_per_compartment;
        let first_live = covered_end.saturating_sub(live_covered) + 1;
        let mut fixture = Self {
            _dir: dir,
            store,
            session,
            messages_per_compartment,
            next_sequence: compartments as i64 + 1,
            covered_end,
            messages: Vec::new(),
            render_generation: 0,
            rng,
        };
        for ordinal in first_live..=covered_end + tail {
            fixture.push_message(ordinal);
        }
        fixture
    }

    fn push_message(&mut self, ordinal: u64) {
        let size = 60 + self.rng.below(400) as usize;
        let text = prose(&mut self.rng, size);
        self.messages
            .push(item(&format!("m{ordinal}"), ordinal, &text));
    }

    pub(super) fn last_ordinal(&self) -> u64 {
        self.messages.last().map_or(0, |message| message.ordinal)
    }

    pub(super) fn append_messages(&mut self, count: u64) {
        let last = self.last_ordinal();
        for ordinal in last + 1..=last + count {
            self.push_message(ordinal);
        }
    }

    /// Publish one compartment over the next uncovered messages, keeping at least
    /// `keep_tail` messages uncovered. Returns false when the tail is too short.
    pub(super) fn publish_compartment(&mut self, keep_tail: u64) -> bool {
        let start = self.covered_end + 1;
        let end = self.covered_end + self.messages_per_compartment;
        if end + keep_tail > self.last_ordinal() {
            return false;
        }
        let row = compartment(&mut self.rng, self.next_sequence, start, end);
        self.store
            .append_compartments(&self.session, &[row])
            .unwrap();
        self.next_sequence += 1;
        self.covered_end = end;
        true
    }

    pub(super) fn request(&self) -> TransformRequest {
        let mut request = req(
            &self.session,
            &format!("large-session-{}", self.render_generation),
            self.messages.clone(),
        );
        request.serializer_profile = "opencode".into();
        request
    }

    /// Mark the next pass as a SOFT refresh, the way a publication signal does.
    pub(super) fn request_soft(&self) {
        let mut loaded = self.store.load(&self.session).unwrap();
        loaded.meta.soft_refresh_pending = true;
        self.store
            .commit(&self.session, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    }

    /// A new render-config identity, which forces the next pass to fold (HARD).
    pub(super) fn request_fold(&mut self) {
        self.render_generation += 1;
    }

    pub(super) fn context(&self) -> ProducerContext<'static> {
        let mut context = pctx(PROJECT, "/nonexistent-docs", NOW_MS);
        context.memory_budget_tokens = 15_000.0;
        context.inject_docs = false;
        context
    }

    pub(super) fn run(&self) -> TransformResponse {
        transform(&self.store, &self.request(), &self.context()).unwrap()
    }

    /// SHA-256 of the frozen m0 and m1 payloads after the last pass.
    pub(super) fn m0_m1_digests(&self) -> [String; 2] {
        let loaded = self.store.load(&self.session).unwrap();
        ["m0", "m1"].map(|key| {
            loaded
                .core
                .frozen_units
                .iter()
                .find(|unit| unit.key == key)
                .map_or_else(
                    || "absent".to_string(),
                    |unit| format!("{:x}", Sha256::digest(unit.frozen_payload.as_bytes())),
                )
        })
    }
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Prints stage timings for real passes over a synthetic session at production
/// scale: `MC_COMPOSE_COMPARTMENTS` (default 2,300), `MC_COMPOSE_MEMORIES`
/// (default 300) and `MC_COMPOSE_CYCLES` fold cycles (default 5). Each cycle
/// appends live messages, publishes one compartment, then runs a defer, a SOFT
/// and a HARD fold. Run in release:
/// `cargo test -p mc-module --release --lib large_session_compose_profile -- --ignored --nocapture`.
#[test]
#[ignore = "release-mode performance profile; prints timings"]
fn large_session_compose_profile() {
    let compartments = env_usize("MC_COMPOSE_COMPARTMENTS", 2_300);
    let memories = env_usize("MC_COMPOSE_MEMORIES", 300);
    let cycles = env_usize("MC_COMPOSE_CYCLES", 5);
    let build_started = Instant::now();
    let live_covered = env_usize("MC_COMPOSE_LIVE_COVERED", 400) as u64;
    let mut fixture = LargeSession::new(0x5eed, compartments, 65, memories, live_covered, 600);
    let rows = fixture.store.load_compartments(&fixture.session).unwrap();
    let tier_bytes = rows
        .iter()
        .map(|row| {
            row.title.len()
                + row.content.len()
                + [&row.p1, &row.p2, &row.p3, &row.p4]
                    .iter()
                    .map(|tier| tier.as_deref().map_or(0, str::len))
                    .sum::<usize>()
        })
        .sum::<usize>();
    eprintln!(
        "large-session fixture compartments={} memories={memories} compartment_text_bytes={tier_bytes} live_messages={} covered_end={} build_ms={:.1}",
        rows.len(),
        fixture.messages.len(),
        fixture.covered_end,
        build_started.elapsed().as_secs_f64() * 1000.0,
    );
    let print = |label: &str, fixture: &LargeSession, response: &TransformResponse, wall: f64| {
        let timings = response.timings.as_ref().unwrap();
        let [m0, m1] = fixture.m0_m1_digests();
        eprintln!(
            "large-session pass={label} decision={} wall={wall:.1} total={:.1} planning={:.1} state_evolution={:.1} compose_m0m1={:.1} decay_render_ms={:.1} tier_tokenize_ms={:.1} memory_render_ms={:.1} build_output={:.1} store_commit={:.1} m0={} m1={}",
            response.decision,
            timings.total,
            timings.planning,
            timings.state_evolution,
            timings.compose_m0m1,
            timings.compose.decay_render_ms,
            timings.compose.tier_tokenize_ms,
            timings.compose.memory_render_ms,
            timings.build_output,
            timings.store_commit,
            &m0[..12],
            &m1[..12],
        );
    };
    let timed = |fixture: &LargeSession| {
        let started = Instant::now();
        let response = fixture.run();
        (response, started.elapsed().as_secs_f64() * 1000.0)
    };
    let (response, wall) = timed(&fixture);
    print("cold", &fixture, &response, wall);
    for cycle in 0..cycles {
        fixture.append_messages(80);
        assert!(fixture.publish_compartment(200));
        let (response, wall) = timed(&fixture);
        print(&format!("c{cycle}-defer"), &fixture, &response, wall);
        fixture.request_soft();
        let (response, wall) = timed(&fixture);
        print(&format!("c{cycle}-soft"), &fixture, &response, wall);
        fixture.request_fold();
        let (response, wall) = timed(&fixture);
        print(&format!("c{cycle}-fold"), &fixture, &response, wall);
    }
}
