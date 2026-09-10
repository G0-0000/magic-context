fn reasoning_clear_fixture() -> TransformRequest {
    fn message(mid: &str, ordinal: u64, role: &str, signed: bool) -> CkIngressMessage {
        let mut content = Vec::new();
        if signed {
            content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: format!("thinking-{mid}"),
                signature: Some(format!("signature-{mid}")),
            }));
        }
        content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
            text: format!("content-{mid}"),
        }));
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                content,
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }
    let mut multipart = message("multipart-user", 4, "user", false);
    for index in 0..12 {
        multipart
            .ck
            .content
            .push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: format!("Additional user text part {index}"),
            }));
    }
    let mut request = active_opencode_req(
        "reasoning-clear-decisions",
        "cfg0",
        vec![
            message("user", 1, "user", false),
            message("old", 2, "assistant", true),
            multipart,
        ],
    );
    request.provider_id = Some("anthropic".to_string());
    request.serve_native = true;
    request.clear_reasoning_age = 10;
    with_usage(request, 10_000, 100_000)
}

fn reasoning_clear_target(response: &TransformResponse) -> Vec<u8> {
    response
        .messages()
        .iter()
        .find(|message| message.meta.harness_id.as_deref() == Some("old"))
        .unwrap()
        .canonical_bytes()
        .to_vec()
}

fn reasoning_clear_native(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Vec<Value> {
    crate::encode_full_native_messages(
        &result.response,
        request,
        &result.reasoning_clear_units,
        &result.tag_numbers,
        result.mutation_exempt_mid.as_deref(),
        result.lineage_anchor_mid.as_deref(),
        result.transition_consumed,
    )
}

fn reasoning_clear_native_target(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Value {
    reasoning_clear_native(result, request)
        .into_iter()
        .find(|message| message["info"]["id"] == "old")
        .unwrap()
}

#[test]
fn reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = reasoning_clear_fixture();
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let original = reasoning_clear_target(&hard.response);
    let original_native = reasoning_clear_native_target(&hard, &request);
    assert!(String::from_utf8_lossy(&original).contains("thinking-old"));
    assert!(hard.reasoning_watermark >= hard.tag_numbers["old"]);
    drop(db);
    let db = store(dir.path());
    let unchanged = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(unchanged.response.action, "SOFT+");
    assert_eq!(reasoning_clear_target(&unchanged.response), original);
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let deferred = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    assert_eq!(deferred.reasoning_watermark, hard.reasoning_watermark);
    assert_eq!(
        reasoning_clear_target(&deferred.response),
        original,
        "DEFER must not first-clear reasoning merely because its exemption moved"
    );
    assert_eq!(
        reasoning_clear_native_target(&deferred, &request),
        original_native
    );
    assert!(deferred.response.first_divergence.is_none());
    request.render_config = "cfg2".to_string();
    let applied = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(applied.response.action, "HARD");
    let cleared = reasoning_clear_target(&applied.response);
    let cleared_native = reasoning_clear_native_target(&applied, &request);
    assert!(!String::from_utf8_lossy(&cleared).contains("thinking-old"));
    assert_ne!(original_native, cleared_native);
    for _ in 0..2 {
        let replay = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert_eq!(reasoning_clear_target(&replay.response), cleared);
        assert_eq!(
            reasoning_clear_native_target(&replay, &request),
            cleared_native
        );
        assert!(replay.response.first_divergence.is_none());
    }
}

#[test]
fn reasoning_clear_legacy_adoption_preserves_cleared_and_held_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = reasoning_clear_fixture();
    let mut already = request.messages[1].clone();
    already.mid = "already".to_string();
    already.ck.meta.harness_id = Some("already".to_string());
    for message in request.messages.iter_mut().skip(1) {
        message.ordinal += 2;
    }
    request.messages.insert(1, already);
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let before = transform_with_projection(&db, &request, &ctx).unwrap();
    let before_native = reasoning_clear_native(&before, &request);
    assert!(reasoning_clear_mids(&before.reasoning_clear_units).contains("already"));
    assert!(!reasoning_clear_mids(&before.reasoning_clear_units).contains("old"));
    // A legacy row has exactly these served bytes and watermark, but no applied-set units.
    let mut legacy = db.load(&request.session_id).unwrap();
    legacy
        .core
        .frozen_units
        .retain(|unit| !unit.key.starts_with("strip:reasoning_clear:"));
    db.commit(
        &request.session_id,
        legacy.row_version,
        &legacy.core,
        &legacy.meta,
    )
    .unwrap();
    drop(db);
    let db = store(dir.path());
    let mut newer = request.messages[2].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 19;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let adopted = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(adopted.response.action, "SOFT+");
    let adopted_native = reasoning_clear_native(&adopted, &request);
    assert_eq!(adopted_native.len(), before_native.len() + 1);
    assert_eq!(
        &adopted_native[..before_native.len()],
        before_native.as_slice()
    );
    assert!(adopted.response.first_divergence.is_none());
    assert_eq!(
        reasoning_clear_target(&adopted.response),
        reasoning_clear_target(&before.response)
    );
    for message in before.response.messages() {
        let mid = message.meta.harness_id.as_deref();
        if mid == Some("already") || mid == Some("old") {
            let after = adopted
                .response
                .messages()
                .iter()
                .find(|candidate| candidate.meta.harness_id.as_deref() == mid)
                .unwrap();
            assert_eq!(message.canonical_bytes(), after.canonical_bytes());
        }
    }
    assert!(reasoning_clear_mids(&adopted.reasoning_clear_units).contains("already"));
    assert!(!reasoning_clear_mids(&adopted.reasoning_clear_units).contains("old"));
    assert_eq!(
        reasoning_clear_native_target(&adopted, &request),
        reasoning_clear_native_target(&before, &request)
    );
    request.render_config = "cfg2".to_string();
    let priced = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(priced.response.action, "HARD");
    assert!(reasoning_clear_mids(&priced.reasoning_clear_units).contains("old"));
    assert!(
        !String::from_utf8_lossy(&reasoning_clear_target(&priced.response))
            .contains("thinking-old")
    );
}

#[test]
fn reasoning_clear_legacy_missing_fingerprint_holds_until_bust() {
    let mut request = reasoning_clear_fixture();
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let core = CoreState::default();
    let meta = ModuleMeta {
        reasoning_cleared_through_tag: 5,
        ..Default::default()
    };
    let tags = BTreeMap::from([("old".to_string(), 2), ("new".to_string(), 16)]);
    assert!(new_reasoning_clear_units(&core, &meta, &request, &tags, false, None).is_empty());
    let units = new_reasoning_clear_units(&core, &meta, &request, &tags, true, None);
    assert_eq!(reasoning_clear_mids(&units), HashSet::from(["old"]));
}
