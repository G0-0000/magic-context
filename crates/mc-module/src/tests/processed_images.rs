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
