//! Cache-safety witness for `BoundaryState::BehindHostMarker`.
//!
//! OpenCode sends nothing older than the row its persisted compaction marker sits on.
//! When the module's boundary is an older compartment end, that boundary never comes
//! back into a request, and the module used to serve the session raw forever.
//! `host_marker_trim` now treats such a request as a trim the host declared (the
//! compartments render in the prefix, every live message is kept) when the request
//! names the marker row and that row leads the array.
//!
//! The shape used here: compartments cover ordinals 1..=5 (module boundary `m5#0`,
//! coverage 5), the marker sits on `m9`, and the test requests carry `m9` onward, the
//! way OpenCode would, so `m6..=m8` are never in a request.

use super::tests::{item, pctx, req, store};
use super::*;

const SESSION: &str = "behind-marker-review";

fn compartment(sequence: i64, start: i64, end: i64, body: &str) -> StoredCompartment {
    StoredCompartment {
        sequence,
        start_message: start,
        end_message: end,
        start_message_id: format!("m{start}#0"),
        end_message_id: format!("m{end}#0"),
        title: format!("C{sequence}"),
        content: body.to_string(),
        p1: Some(body.to_string()),
        importance: 50,
        ..Default::default()
    }
}

/// Set the module's boundary to `boundary` through the host state-sync seed, which is
/// how a host hands the module a boundary for a session whose module state was reset.
fn seed_boundary(s: &McStore, boundary: &str) {
    s.apply_authority_state_sync(mc_store::ModuleStateSyncRequest {
        resolved_compartment_boundaries: &[],
        session_id: SESSION,
        project_path: "git:proj",
        shadow_generation: 0,
        expected_shadow_seq: 0,
        seed_boundary_id: Some(boundary),
        drop_seeds: &[],
        drop_seed_skipped: 0,
        strip_seeds: &[],
        strip_seed_skipped: 0,
        reasoning_cleared_through_tag: None,
        last_todo_state: None,
        pending_agent_drops: &[],
        pending_agent_drops_skipped: 0,
        user_hint_seeds: &[],
        auto_search_hint_skipped: 0,
        note_nudge_anchors: None,
        todo_synthetic_anchor: None,
        todo_synthetic_anchor_present: false,
        emergency_latches: None,
        pending_compaction_marker: None,
        deferred_execute_state: None,
        channel2_nudge_state: None,
        acked_watermarks: Value::Null,
    })
    .unwrap();
}

fn live(range: std::ops::RangeInclusive<u64>) -> Vec<CkIngressMessage> {
    range
        .map(|ordinal| item(&format!("m{ordinal}"), ordinal, &format!("turn {ordinal}")))
        .collect()
}

fn pass(
    s: &McStore,
    dir: &str,
    messages: Vec<CkIngressMessage>,
    marker: Option<&str>,
) -> Result<TransformWithProjection, TransformError> {
    let mut request = req(SESSION, "cfg0", messages);
    request.compaction_marker_message_id = marker.map(str::to_string);
    transform_with_projection(s, &request, &pctx("git:proj", dir, 1))
}

/// The store already holds a compartment (6..=7) that ends between the module's
/// coverage and the marker row: published, not yet folded, when the session went raw.
/// `host_marker_trim` accepts the trim because the boundary `m5#0` is a stored
/// compartment end at coverage, but the rebuild it enables folds every stored
/// compartment and mints `m7#0`, a row the host never sends. `boundary_available` only
/// accepts the synthesized trim's own boundary (`m5#0`), so every pass returns
/// `BoundaryNotPresent`. The error aborts before commit, so `pending_rewrite` stays
/// armed and the historian, which does not run while it is armed, never publishes past
/// the marker to heal it; the plugin parks the session after three failed passes.
///
/// Without the marker id (an older plugin, and the module before the recovery) the same
/// state is served as a quiet raw pass-through. The recovery must not turn that into a
/// failing session: it should either serve a managed pass or keep the raw one.
#[test]
fn behind_marker_recovery_does_not_fail_when_an_unfolded_compartment_ends_before_the_marker_row() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let dir = dir.path().to_str().unwrap().to_string();
    s.replace_compartments(SESSION, &[compartment(1, 1, 5, "S-OLD")])
        .unwrap();
    seed_boundary(&s, "m5#0");
    let raw = pass(&s, &dir, live(9..=12), None).unwrap();
    assert_eq!(raw.response.action, "PASSTHROUGH");
    let mut rows = s.load_compartments(SESSION).unwrap();
    rows.push(compartment(2, 6, 7, "S-GAP"));
    s.replace_compartments(SESSION, &rows).unwrap();

    let without_marker = pass(&s, &dir, live(9..=12), None);
    assert_eq!(
        without_marker.unwrap().response.action,
        "PASSTHROUGH",
        "the markerless (base) path serves this state raw"
    );
    let outcomes = (12..=14u64)
        .map(|end| match pass(&s, &dir, live(9..=end), Some("m9")) {
            Ok(result) => format!("{}:{:?}", result.response.action, result.boundary_state),
            Err(error) => format!("error:{error}"),
        })
        .collect::<Vec<_>>();
    assert!(
        outcomes.iter().all(|outcome| !outcome.starts_with("error")),
        "every pass with the marker id failed: {outcomes:?}; pending_rewrite still armed: {}",
        s.load(SESSION).unwrap().meta.pending_rewrite.is_some()
    );
}

/// Raw session (boundary `m5#0`, coverage 5) whose store also holds a published,
/// unfolded compartment 6..=7 ending at `gap_end_id`. Returns the store and its
/// directory; the first markerless pass has already armed `pending_rewrite`.
fn raw_session_with_gap_compartment(gap_end_id: &str) -> (tempfile::TempDir, McStore, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let path = dir.path().to_str().unwrap().to_string();
    s.replace_compartments(SESSION, &[compartment(1, 1, 5, "S-OLD")])
        .unwrap();
    seed_boundary(&s, "m5#0");
    let raw = pass(&s, &path, live(9..=12), None).unwrap();
    assert_eq!(raw.response.action, "PASSTHROUGH");
    let mut gap = compartment(2, 6, 7, "S-GAP");
    gap.end_message_id = gap_end_id.to_string();
    let mut rows = s.load_compartments(SESSION).unwrap();
    rows.push(gap);
    s.replace_compartments(SESSION, &rows).unwrap();
    (dir, s, path)
}

fn served(result: &TransformWithProjection) -> Value {
    serde_json::to_value(result.response.messages()).unwrap()
}

/// The recovery folds the gap compartment and anchors on its end `m7#0`, a row the host
/// never sends. That costs one rebuild; the next passes with the same marker recognize
/// the trim from the new anchor and replay the frozen bytes without another rebuild.
#[test]
fn behind_marker_recovery_folds_an_unfolded_gap_compartment_with_one_rebuild() {
    let (_dir, s, path) = raw_session_with_gap_compartment("m7#0");

    let recovered = pass(&s, &path, live(9..=12), Some("m9")).unwrap();
    assert_eq!(recovered.response.action, "HARD");
    assert_eq!(recovered.boundary_state, BoundaryState::BehindHostMarker);
    assert_eq!(recovered.response.boundary_id, "m7#0");
    let served_text = served(&recovered).to_string();
    assert!(served_text.contains("S-OLD"), "{served_text}");
    assert!(served_text.contains("S-GAP"), "{served_text}");
    let loaded = s.load(SESSION).unwrap();
    assert_eq!(loaded.core.boundary_id, "m7#0");
    assert_eq!(loaded.meta.coverage_ordinal, Some(7));
    assert!(loaded.meta.pending_rewrite.is_none());

    for _ in 0..2 {
        let defer = pass(&s, &path, live(9..=12), Some("m9")).unwrap();
        assert_eq!(defer.response.action, "SOFT+");
        assert_eq!(defer.boundary_state, BoundaryState::BehindHostMarker);
        assert_eq!(served(&defer), served(&recovered));
    }
    let appended = pass(&s, &path, live(9..=13), Some("m9")).unwrap();
    assert_ne!(appended.response.action, "HARD");
    assert_eq!(appended.boundary_state, BoundaryState::BehindHostMarker);
    assert!(s.load(SESSION).unwrap().meta.pending_rewrite.is_none());
}

/// The mint guard still refuses a gap anchor that cannot be the end of a trimmed row:
/// a bare message id (wrong vocabulary) and a block id of a message the host did send.
/// Both stay `BoundaryNotPresent`, as they were before gap anchors were accepted.
#[test]
fn behind_marker_mint_guard_still_refuses_unpresentable_gap_anchors() {
    for gap_end_id in ["m7", "m9#3"] {
        let (_dir, s, path) = raw_session_with_gap_compartment(gap_end_id);
        let result = pass(&s, &path, live(9..=12), Some("m9"));
        assert!(
            matches!(result, Err(TransformError::BoundaryNotPresent(_))),
            "{gap_end_id}: {:?}",
            result.map(|r| r.response.action)
        );
    }
}
