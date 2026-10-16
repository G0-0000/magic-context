fn processed_image_message(mid: &str, ordinal: u64) -> CkIngressMessage {
    let mut message = item(mid, ordinal, "");
    message.ck.content = vec![CkWireBlock::bare(ck_wire::CkKind::Media(
        ck_wire::MediaBlock {
            kind: ck_wire::MediaKind::Image,
            media_type: "image/png".into(),
            filename: None,
            source: json!({"type": "data_base64", "data": "x".repeat(300)}),
        },
    ))];
    message
}

fn processed_image_plan(
    core: &CoreState,
    request: &TransformRequest,
    tags: &BTreeMap<String, u64>,
    watermark: u64,
    bust: bool,
) -> Vec<FrozenUnit> {
    new_frozen_strip_units(
        core,
        request,
        tags,
        None,
        bust,
        StripSelectionScope {
            reasoning: ReasoningBudgetScope {
                coverage: 0,
                anchor: None,
            },
            image_watermark: watermark,
        },
        &HashSet::new(),
    )
}

#[test]
fn processed_images_freeze_provider_marker_and_replay_after_restart() {
    for provider in ["anthropic", "openai", "opencode-zen", "mock"] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = req(
            "image-provider",
            "cfg0",
            vec![
                item("head", 0, "older history"),
                processed_image_message("image", 1),
                wire_item("assistant", "answer", 2, &["processed"]),
                item("dropper", 3, "spent"),
            ],
        );
        request.provider_id = Some(provider.into());
        let baseline = run(&s, &request, &spine());
        assert!(baseline
            .messages()
            .iter()
            .any(|m| m.content.iter().any(image_block_is_large)));
        s.seed_tags_for_test(
            &request.session_id,
            &[mc_store::TagMintInput {
                block_id: "dropper#0".into(),
                kind: "message".into(),
                token_count: 1,
                source_bytes: b"spent".to_vec(),
            }],
            0,
        )
        .unwrap();
        request.render_config = "cfg1".into();
        let bust = run(&s, &request, &[reduce("dropper#0", "drop", "")]);
        assert_eq!(bust.action, "HARD");
        let expected = if provider == "anthropic" {
            ""
        } else {
            "[image stripped]"
        };
        assert_eq!(tail_bytes(&bust, "image"), expected);
        let loaded = s.load(&request.session_id).unwrap();
        for key in ["strip:processed_image:image", "red:image#0"] {
            assert_eq!(
                loaded
                    .core
                    .frozen_units
                    .iter()
                    .find(|u| u.key == key)
                    .unwrap()
                    .frozen_payload,
                expected
            );
        }
        drop(s);
        let s = store(dir.path());
        run(&s, &request, &spine());
        let replay = run(&s, &request, &spine());
        assert_eq!(replay.action, "SOFT+");
        assert_eq!(tail_bytes(&replay, "image"), expected);
        // Changing providers must not change the text already served in place of the image.
        request.provider_id = Some(
            if provider == "anthropic" {
                "openai"
            } else {
                "anthropic"
            }
            .into(),
        );
        let switched = run(&s, &request, &spine());
        assert_eq!(tail_bytes(&switched, "image"), expected);
    }
}

#[test]
fn processed_images_discovery_needs_bust_but_legacy_units_replay_on_every_provider() {
    let mut request = req(
        "legacy-image",
        "cfg",
        vec![
            processed_image_message("image", 1),
            wire_item("assistant", "answer", 2, &["processed"]),
        ],
    );
    let tags = BTreeMap::from([("answer".into(), 1)]);
    for provider in [None, Some("anthropic"), Some("openai")] {
        request.provider_id = provider.map(str::to_owned);
        assert!(processed_image_plan(&CoreState::default(), &request, &tags, 1, false).is_empty());
        let mut core = CoreState::default();
        core.frozen_units
            .push(strip_unit("processed_image", "image", ""));
        let projection = project_messages(&request.messages).unwrap();
        let output = build_output(
            &core,
            &ModuleMeta::default(),
            &projection,
            &request,
            None,
            false,
            None,
        )
        .unwrap();
        let image = output
            .iter()
            .find(|m| m.meta.harness_id.as_deref() == Some("image"))
            .unwrap();
        assert_eq!(
            image.content,
            vec![CkWireBlock::bare(ck_wire::CkKind::Text {
                text: String::new()
            })]
        );
    }
}

#[test]
fn processed_images_provider_switch_during_signed_hold_keeps_frozen_bytes() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "image-switch-hold");
    sim.messages[2] = processed_image_message("u3", 3);
    sim.run(false).unwrap();
    let mut loaded = sim.s().load(&sim.session).unwrap();
    loaded
        .core
        .frozen_units
        .push(strip_unit("processed_image", "u3", ""));
    sim.s()
        .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    sim.tool_step();
    let held = sim.run(false).unwrap();
    assert!(review_serves_signature(&held, "think 4"));
    assert!(!held
        .messages()
        .iter()
        .any(|m| m.content.iter().any(image_block_is_large)));
    let mut request = sim.request(false);
    request.provider_id = Some("openai".into());
    let switched = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(switched.action, "SOFT+");
    assert_eq!(review_bytes(&held), review_bytes(&switched));
}

fn render_processed_image_plan(
    request: &TransformRequest,
    units: Vec<FrozenUnit>,
) -> Vec<CkWireMessage> {
    let mut core = CoreState::default();
    core.frozen_units = units;
    let projection = project_messages(&request.messages).unwrap();
    build_output(
        &core,
        &ModuleMeta::default(),
        &projection,
        request,
        None,
        false,
        None,
    )
    .unwrap()
}

#[test]
fn processed_images_strip_nested_native_tool_media_without_emptying_results() {
    for provider in ["anthropic", "openai"] {
        for error in [false, true] {
            let data = "x".repeat(300);
            let pi_raw = vec![json!({
                "role": "toolResult", "toolCallId": "call", "toolName": "read", "isError": error,
                "content": [{"type": "image", "mimeType": "image/png", "data": data, "vendor": "image-extra"}]
            })];
            let decoded = crate::codec::pi::decode_pi(&pi_raw);
            let mut request = req("tool-images", "cfg", decoded.messages);
            request
                .messages
                .insert(0, assistant_tool_call("call", 0, "call"));
            request.provider_id = Some(provider.into());
            assert!(request.messages.iter().any(|m| m
                .ck
                .content
                .iter()
                .any(tool_image_block_is_large)));
            assert!(
                processed_image_plan(&CoreState::default(), &request, &BTreeMap::new(), 1, true)
                    .is_empty(),
                "a result needs a later assistant answer"
            );
            request
                .messages
                .push(wire_item("assistant", "answer", 100, &["processed"]));
            let tags = BTreeMap::from([("answer".into(), 1)]);
            let units = processed_image_plan(&CoreState::default(), &request, &tags, 1, true);
            assert!(units
                .iter()
                .any(|u| u.kind == "image" && u.frozen_payload == "[image stripped]"));
            let output = render_processed_image_plan(&request, units);
            let encoded = crate::codec::pi::encode_pi(&output, &decoded.sidecar);
            let result = encoded.iter().find(|m| m["role"] == "toolResult").unwrap();
            assert_eq!(result["isError"], error);
            assert_eq!(
                result["content"],
                json!([{"type": "text", "text": "[image stripped]"}])
            );
            assert!(!serde_json::to_string(&encoded).unwrap().contains(&data));

            let oc_raw = vec![json!({
                "info": {"id": "tool", "role": "assistant"},
                "parts": [{"type": "tool", "callID": "call", "tool": "read", "state": {
                    "status": if error {"error"} else {"completed"}, "input": {},
                    "output": "", "error": "", "attachments": [
                        {"mime": "image/png", "url": format!("data:image/png;base64,{data}")},
                        {"mime": "image/png", "url": "https://example.test/keep.png"},
                        {"mime": "image/png", "url": "data:image/png;base64,small"}
                    ], "time": {"start": 1, "end": 2}
                }}]
            })];
            let decoded = crate::codec::opencode::decode_opencode(&oc_raw);
            let mut request = req("tool-images", "cfg", decoded.messages);
            request.provider_id = Some(provider.into());
            assert!(
                processed_image_plan(&CoreState::default(), &request, &tags, 1, true).is_empty(),
                "the assistant containing the result is not a later answer"
            );
            request
                .messages
                .push(wire_item("assistant", "answer", 100, &["processed"]));
            let units = processed_image_plan(&CoreState::default(), &request, &tags, 1, true);
            assert!(units
                .iter()
                .any(|u| u.key == "strip:processed_tool_image:tool"));
            let output = render_processed_image_plan(&request, units);
            let encoded = crate::codec::opencode::encode_opencode(&output, &decoded.sidecar, None);
            let state = &encoded[0]["parts"][0]["state"];
            assert_eq!(state["status"], if error { "error" } else { "completed" });
            assert!(state[if error { "error" } else { "output" }]
                .as_str()
                .unwrap()
                .contains("[image stripped]"));
            assert_eq!(state["attachments"].as_array().unwrap().len(), 2);
            assert!(!serde_json::to_string(&encoded).unwrap().contains(&data));
        }
    }
}

#[test]
fn processed_images_nested_tool_decisions_persist_and_replay_on_defer() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let decoded = crate::codec::pi::decode_pi(&[json!({
        "role": "toolResult", "toolCallId": "call", "toolName": "read",
        "content": [{"type": "image", "mimeType": "image/png", "data": "x".repeat(300)}]
    })]);
    let mut messages = vec![assistant_tool_call("call", 0, "call")];
    messages.extend(decoded.messages);
    messages.push(wire_item("assistant", "answer", 100, &["processed"]));
    messages.push(item("dropper", 101, "spent"));
    let mut request = req("tool-image-replay", "cfg0", messages);
    request.provider_id = Some("anthropic".into());
    run(&s, &request, &spine());
    s.seed_tags_for_test(
        &request.session_id,
        &[mc_store::TagMintInput {
            block_id: "dropper#0".into(),
            kind: "message".into(),
            token_count: 1,
            source_bytes: b"spent".to_vec(),
        }],
        0,
    )
    .unwrap();
    request.render_config = "cfg1".into();
    let bust = run(&s, &request, &[reduce("dropper#0", "drop", "")]);
    assert_eq!(bust.action, "HARD");
    assert!(s
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|u| u.key.starts_with("strip:processed_tool_image:")));
    assert!(!bust
        .messages()
        .iter()
        .any(|m| m.content.iter().any(tool_image_block_is_large)));
    run(&s, &request, &spine());
    let replay = run(&s, &request, &spine());
    assert_eq!(replay.action, "SOFT+");
    assert_eq!(
        serde_json::to_vec(bust.messages()).unwrap(),
        serde_json::to_vec(replay.messages()).unwrap()
    );
}
