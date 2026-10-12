// An unfinished Anthropic thinking turn on a prefix-bound model holds every pass below the
// force band: whatever is queued (an explicit flush, ctx_reduce drops, a selected reduction,
// a marker HARD) stays queued, the pass serves the previous bytes, and the next real user
// message applies all of it in one rewrite. The force band and the 95% emergency still
// relieve pressure inside the turn, and a pass that rewrites the prefix anyway carries the
// queued work with it. Every case below keeps one drop target before the kept signed
// thinking (`old-answer#0`), which the per-target thinking protection must withhold while
// the turn is open, and one after it (`a2#0`), which any rewrite may apply.

const SIGNED_HOLD_MODEL: &str = "anthropic/claude-opus-5-5";
const SIGNED_HOLD_LATE_TARGET: &str = "a2#0";
const SIGNED_HOLD_EARLY_TARGET: &str = "old-answer#0";

fn signed_hold_reasoning(text: &str) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Reasoning {
        text: text.to_string(),
        signature: Some(format!("sig-{text}")),
    })
}

fn signed_hold_note(text: &str) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Text {
        text: text.to_string(),
    })
}

/// A finished earlier turn, then an unfinished tool loop whose first step carries signed
/// thinking. `a2` has no thinking of its own, so its note follows the kept signed block.
fn signed_hold_messages() -> Vec<CkIngressMessage> {
    let mut a1 = assistant_tool_call("a1", 4, "t1");
    a1.ck.content.insert(0, signed_hold_reasoning("plan"));
    let mut a2 = assistant_tool_call("a2", 6, "t2");
    a2.ck
        .content
        .insert(0, signed_hold_note("progress note before the second read"));
    vec![
        item("old-prompt", 1, "earlier task"),
        trailing_regression_assistant("old-answer", 2, None, false),
        item("prompt", 3, "current task"),
        a1,
        tool_result("r1", 5, "t1", "first output"),
        a2,
        tool_result("r2", 7, "t2", "second output"),
    ]
}

fn signed_hold_request(session: &str, used: u64) -> TransformRequest {
    let mut request = with_usage(
        opencode_req(session, "cfg0", signed_hold_messages()),
        used,
        100_000,
    );
    request.provider_id = Some("anthropic".to_string());
    request.model_key = Some(SIGNED_HOLD_MODEL.to_string());
    request
}

/// Ends the tool loop: a real user message releases the signed-turn hold.
fn signed_hold_next_user(request: &mut TransformRequest) {
    request.messages.push(item("next-prompt", 8, "continue"));
}

fn signed_hold_bytes(response: &TransformResponse) -> Vec<u8> {
    serde_json::to_vec(&response.ck_messages).unwrap()
}

fn signed_hold_pending(s: &McStore, session: &str) -> BTreeSet<String> {
    s.load_pending_agent_drops(session)
        .unwrap()
        .into_iter()
        .map(|drop| drop.target_id)
        .collect()
}

fn signed_hold_queue_both(s: &McStore, session: &str) {
    s.append_pending_agent_drops(
        session,
        &[
            SIGNED_HOLD_LATE_TARGET.to_string(),
            SIGNED_HOLD_EARLY_TARGET.to_string(),
        ],
        1,
    )
    .unwrap();
}

fn signed_hold_edit_meta(s: &McStore, session: &str, edit: impl FnOnce(&mut ModuleMeta)) {
    let mut loaded = s.load(session).unwrap();
    edit(&mut loaded.meta);
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

/// The earlier prompt is summarized, so the session has a boundary a SOFT can splice onto.
fn signed_hold_compartments(s: &McStore, session: &str) {
    s.replace_compartments(session, &[comp(1, 1, 1, "old-prompt", "SUMMARY")])
        .unwrap();
}

/// Bootstraps the session inside the open turn and returns the steady-state serve at `used`.
fn signed_hold_baseline(s: &McStore, session: &str, used: u64) -> TransformResponse {
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    signed_hold_compartments(s, session);
    transform(s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    let baseline = transform(s, &signed_hold_request(session, used), &ctx).unwrap();
    assert_eq!(
        baseline.action, "SOFT+",
        "the baseline itself must not rewrite"
    );
    baseline
}

/// The held pass must be a Defer that serves the previous bytes and consumes nothing.
fn assert_signed_hold_deferred(
    held: &TransformResponse,
    previous: &TransformResponse,
    s: &McStore,
    session: &str,
    expected_pending: usize,
) {
    assert_eq!(
        held.action, "SOFT+",
        "a held pass is a Defer (reason {:?})",
        held.materialize_reason
    );
    assert!(!held.prefix_bust_permitted);
    assert_eq!(signed_hold_bytes(held), signed_hold_bytes(previous));
    assert_eq!(signed_hold_pending(s, session).len(), expected_pending);
}

#[test]
fn signed_prefix_hold_defers_flush_and_queued_drops_to_the_next_user_turn() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-flush";
    // 66% is above the 65% execute threshold and below the 85% force band.
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_queue_both(&s, session);
    signed_hold_edit_meta(&s, session, |meta| meta.soft_refresh_pending = true);
    let mut request = signed_hold_request(session, 66_000);
    for _ in 0..2 {
        let held = transform(&s, &request, &ctx).unwrap();
        assert_signed_hold_deferred(&held, &baseline, &s, session, 2);
        assert!(s.load(session).unwrap().meta.soft_refresh_pending);
    }

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert!(
        matches!(applied.action.as_str(), "SOFT" | "HARD"),
        "the next user turn applies the held work: {}",
        applied.action
    );
    assert!(signed_hold_pending(&s, session).is_empty());
    assert!(!s.load(session).unwrap().meta.soft_refresh_pending);
    // One rewrite applied everything: the pass after it replays those bytes.
    let after = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after.action, "SOFT+");
    assert_eq!(signed_hold_bytes(&after), signed_hold_bytes(&applied));
}

#[test]
fn signed_prefix_hold_keeps_a_selected_reduction_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = "signed-hold-reduction";
    let baseline = signed_hold_baseline(&s, session, 20_000);
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    // A reduction selected on its own, with no other ride on the pass.
    ctx.injected_reductions = vec![ReductionDecision {
        target_id: SIGNED_HOLD_LATE_TARGET.to_string(),
        kind: "drop".to_string(),
        payload: "[dropped while held]".to_string(),
    }];
    let mut request = signed_hold_request(session, 20_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 0);

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert_eq!(applied.action, "SOFT");
    assert!(String::from_utf8(signed_hold_bytes(&applied))
        .unwrap()
        .contains("[dropped while held]"));
}

#[test]
fn signed_prefix_hold_keeps_a_marker_hard_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-marker";
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_edit_meta(&s, session, |meta| meta.project_memory_epoch_pending = true);
    let mut request = signed_hold_request(session, 66_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 0);
    assert!(s.load(session).unwrap().meta.project_memory_epoch_pending);

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert_eq!(applied.action, "HARD");
    assert!(!s.load(session).unwrap().meta.project_memory_epoch_pending);
}

#[test]
fn signed_prefix_hold_keeps_subagent_execute_drops_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-subagent";
    signed_hold_compartments(&s, session);
    let subagent = |used: u64| {
        let mut request = signed_hold_request(session, used);
        request.is_subagent = true;
        request
    };
    transform(&s, &subagent(20_000), &ctx).unwrap();
    let baseline = transform(&s, &subagent(66_000), &ctx).unwrap();
    s.append_pending_agent_drops(session, &[SIGNED_HOLD_LATE_TARGET.to_string()], 1)
        .unwrap();
    let mut request = subagent(66_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 1);

    signed_hold_next_user(&mut request);
    transform(&s, &request, &ctx).unwrap();
    assert!(signed_hold_pending(&s, session).is_empty());
}

/// Pressure relief inside the held turn: the late drop lands, the early one stays withheld.
fn check_signed_hold_relief(session: &str, used: u64, recovery_armed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let baseline = signed_hold_baseline(&s, session, 20_000);
    signed_hold_queue_both(&s, session);
    let mut request = signed_hold_request(session, used);
    request.emergency_recovery_armed = recovery_armed;
    let relieved = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
        "{session}: only the drop before the kept signed thinking waits ({})",
        relieved.action
    );
    assert_ne!(
        relieved.action, "SOFT+",
        "{session}: pressure relief must rewrite"
    );
    assert_ne!(signed_hold_bytes(&relieved), signed_hold_bytes(&baseline));
}

#[test]
fn signed_prefix_hold_yields_to_the_force_band() {
    check_signed_hold_relief("signed-hold-force", 86_000, false);
}

#[test]
fn signed_prefix_hold_yields_to_the_95_percent_emergency() {
    check_signed_hold_relief("signed-hold-emergency", 95_000, false);
}

/// An armed overflow recovery is a 95% emergency below the force band.
#[test]
fn signed_prefix_hold_yields_to_an_armed_overflow_recovery() {
    check_signed_hold_relief("signed-hold-recovery", 30_000, true);
}

/// A pass that rewrites the prefix anyway carries the queued drops, under the per-target
/// thinking protection. `prepare` sets up the unavoidable rewrite on a bootstrapped session.
fn check_signed_hold_rides_unavoidable_rewrite(
    session: &str,
    prepare: impl FnOnce(&McStore, &mut ProducerContext<'static>),
) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let baseline = signed_hold_baseline(&s, session, 20_000);
    prepare(&s, &mut ctx);
    signed_hold_queue_both(&s, session);
    let rewritten = transform(&s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
        "{session}: the late drop rides; the one before kept signed thinking waits ({})",
        rewritten.action
    );
    assert_eq!(rewritten.action, "HARD", "{session}");
    assert_ne!(signed_hold_bytes(&rewritten), signed_hold_bytes(&baseline));
}

#[test]
fn signed_prefix_hold_first_render_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-first-render";
    signed_hold_compartments(&s, session);
    signed_hold_queue_both(&s, session);
    let first = transform(&s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    assert_eq!(first.action, "HARD");
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()])
    );
}

#[test]
fn signed_prefix_hold_missing_m1_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-missing-m1", |s, _| {
        let session = "signed-hold-missing-m1";
        let mut loaded = s.load(session).unwrap();
        loaded.core.frozen_units.retain(|unit| unit.key != "m1");
        s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    });
}

/// A lineage descent onto a new host conversation epoch serves a different message array,
/// so the provider's cached prefix is gone and the queued drops ride the descent HARD.
#[test]
fn signed_prefix_hold_lineage_descent_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let prior = "signed-hold-prior";
    let session = "signed-hold-descent";
    seed_fake_compaction_prior(&s, prior);
    signed_hold_queue_both(&s, session);
    let mut request = signed_hold_request(session, 20_000);
    // The host compacted the earlier turn into a continuation summary on the new epoch.
    let summary = continuation_summary("held turn");
    request.messages[0] = wire_item(
        "user",
        "old-prompt",
        1,
        &[
            "<system-reminder>Today's date: 2026-08-06</system-reminder>",
            &summary,
        ],
    );
    request.compaction_observed = true;
    request.lineage_switched = true;
    request.descent_edge_id = 7;
    request.prior_conversation_key = prior.to_string();
    request.prior_epoch = 1;
    request.new_epoch = 2;
    request.constituents = vec![(prior.to_string(), session.to_string(), 2)];
    let descended = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
        "the late drop rides the descent; the one before kept signed thinking waits ({} {:?})",
        descended.action,
        descended.materialize_reason
    );
    assert_eq!(descended.action, "HARD");
    assert_eq!(
        descended.materialize_reason.as_deref(),
        Some("lineage_descent")
    );
}

#[test]
fn signed_prefix_hold_idle_expiry_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-idle", |_, ctx| {
        // The last response landed well over the 5m cache TTL ago.
        ctx.observed_last_response_at_ms = Some(1_000);
        ctx.now_ms = 1_000 + 10 * 60_000;
    });
}

#[test]
fn signed_prefix_hold_bootstrap_seed_fold_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-seed", |s, _| {
        signed_hold_edit_meta(s, "signed-hold-seed", |meta| {
            meta.bootstrap_seed_fold_pending = true;
            meta.soft_refresh_pending = true;
        });
    });
}

#[test]
fn signed_prefix_hold_legacy_baseline_migration_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-legacy", |s, _| {
        let session = "signed-hold-legacy";
        let mut loaded = s.load(session).unwrap();
        loaded.core.frozen_units = vec![synth_region("baseline", "OLD".into())];
        loaded.core.pending_changes.clear();
        loaded.meta.soft_refresh_pending = true;
        s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    });
}

/// Seeded xorshift so the differential sequence is reproducible without a dependency.
struct SignedHoldRng(u64);

impl SignedHoldRng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }
}

/// Digest of every response and queue state over a seeded sequence of tool steps, user
/// turns, queued drops, flushes, usage swings, overflow recoveries and idle gaps. The
/// sessions here never hold (no thinking, or a model whose thinking is not prefix-bound).
fn signed_hold_differential_digest(
    model: &str,
    thinking: bool,
    subagent: bool,
    seed: u64,
) -> String {
    use sha2::Digest as _;
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = format!("signed-hold-diff-{seed}-{thinking}-{subagent}");
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let mut rng = SignedHoldRng(seed);
    s.replace_compartments(&session, &[comp(1, 1, 1, "u1", "SUMMARY")])
        .unwrap();
    let mut messages = vec![item("u1", 1, "task")];
    let mut droppable = Vec::new();
    let mut ordinal = 1u64;
    let mut used = 20_000u64;
    let mut hasher = sha2::Sha256::new();
    for step in 0..28 {
        let mut recovery_armed = false;
        let mut idle = false;
        match rng.below(8) {
            0 | 1 => {
                ordinal += 1;
                let mid = format!("a{ordinal}");
                let call = format!("t{ordinal}");
                let mut assistant = assistant_tool_call(&mid, ordinal, &call);
                assistant
                    .ck
                    .content
                    .insert(0, signed_hold_note(&format!("note {ordinal}")));
                let note_index = if thinking {
                    assistant
                        .ck
                        .content
                        .insert(0, signed_hold_reasoning(&format!("think {ordinal}")));
                    1
                } else {
                    0
                };
                droppable.push(format!("{mid}#{note_index}"));
                messages.push(assistant);
                ordinal += 1;
                messages.push(tool_result(
                    &format!("r{ordinal}"),
                    ordinal,
                    &call,
                    &format!("output {ordinal}"),
                ));
            }
            2 => {
                ordinal += 1;
                let mid = format!("u{ordinal}");
                droppable.push(format!("{mid}#0"));
                messages.push(item(&mid, ordinal, "next step"));
            }
            3 if !droppable.is_empty() => {
                let target = droppable[rng.below(droppable.len() as u64) as usize].clone();
                s.append_pending_agent_drops(&session, &[target], 1)
                    .unwrap();
            }
            4 if step > 0 => {
                signed_hold_edit_meta(&s, &session, |meta| meta.soft_refresh_pending = true);
            }
            5 => used = 20_000 + rng.below(78) * 1_000,
            6 => recovery_armed = true,
            7 => idle = true,
            _ => {}
        }
        if idle {
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
            ctx.now_ms += 10 * 60_000;
        }
        let mut request = with_usage(
            opencode_req(&session, "cfg0", messages.clone()),
            used,
            100_000,
        );
        request.provider_id = Some("anthropic".to_string());
        request.model_key = Some(model.to_string());
        request.is_subagent = subagent;
        request.emergency_recovery_armed = recovery_armed;
        match transform(&s, &request, &ctx) {
            Ok(response) => {
                hasher.update(response.action.as_bytes());
                hasher.update(format!("{:?}", response.materialize_reason).as_bytes());
                hasher.update([u8::from(response.prefix_bust_permitted)]);
                hasher.update(signed_hold_bytes(&response));
            }
            Err(error) => hasher.update(format!("error: {error:?}").as_bytes()),
        }
        for target in signed_hold_pending(&s, &session) {
            hasher.update(target.as_bytes());
        }
        if idle {
            // The provider answered the resend, so the next step is warm again.
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Sessions the hold never covers serve exactly what master served before the hold existed.
/// The digests were captured on master (dda49e3850) with this same sequence; a change here
/// means a session without prefix-bound signed thinking changed behaviour.
#[test]
fn signed_prefix_hold_leaves_unheld_sessions_byte_identical() {
    let cases = [
        ("anthropic/claude-opus-4-5", true, false),
        ("anthropic/claude-opus-4-5", true, true),
        (SIGNED_HOLD_MODEL, false, false),
        (SIGNED_HOLD_MODEL, false, true),
    ];
    let golden: [&str; 4] = [
        "8c2c2a7fcb4b79cb90c9919c0be079f263bd6cc5d16189a083dec566b310b555f1ff7dda34907c007e42791bb27b4562c31f37624003cb638aaa39aa8d09eb42",
        "8cdbcef220819f6b65e541f05babc4678c430d90cb8b3c75959001bf213efa2c45d0f2839701bced8576ccdf22bbae7688b44b01377a4e8d920e5390b05983f6",
        "dd5c4068d06f89c544cc6fe21aa30e4ea81a8454bcfabfe7d7c4622eba3a6bbd90cd462a95a18b66499887ae09ec99531a3aa10c33478811feb5ca3f2b57cd51",
        "3fcb4ffbcdac757fe3154bf9f8baa6741fd23a93331249e1b06767cb8e79b76459fdffe286cf31b24ae80448fda06c954369a2130fc6ea89ac698d796593aba8",
    ];
    let mut actual = Vec::new();
    for (model, thinking, subagent) in cases {
        let mut combined = String::new();
        for seed in [0x9E37_79B9_7F4A_7C15u64, 0xD1B5_4A32_D192_ED03] {
            combined.push_str(&signed_hold_differential_digest(
                model, thinking, subagent, seed,
            ));
        }
        actual.push(combined);
    }
    // Deterministic: a second run of one case reproduces its digest.
    assert_eq!(
        signed_hold_differential_digest(cases[0].0, cases[0].1, cases[0].2, 0x9E37_79B9_7F4A_7C15),
        actual[0][..64]
    );
    assert_eq!(actual, golden, "digests: {actual:#?}");
}
