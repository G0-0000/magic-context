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
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    assert!(new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        false,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection
        }
    )
    .is_empty());
    let units = new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        true,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection,
        },
    );
    assert_eq!(reasoning_clear_mids(&units), HashSet::from(["old"]));
}
