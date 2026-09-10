/// Record which messages actually have their typed reasoning cleared. The age
/// cutoff selects candidates, but a message protected as the newest assistant
/// must wait for another cache-busting pass after a newer assistant arrives.
fn new_reasoning_clear_units(
    core: &CoreState,
    meta: &ModuleMeta,
    req: &TransformRequest,
    tag_numbers: &BTreeMap<String, u64>,
    can_mutate_provider_prefix: bool,
    lineage_anchor_mid: Option<&str>,
) -> Vec<FrozenUnit> {
    if SerializerProfile::parse(&req.serializer_profile) != Some(SerializerProfile::OpencodeAiSdk)
        || !req.serve_native
        || !request_accepts_empty_content(req)
    {
        return Vec::new();
    }
    let cutoff = meta
        .reasoning_cleared_through_tag
        .max(meta.reasoning_cleared_through_ordinal);
    if cutoff == 0 {
        return Vec::new();
    }
    let newest = latest_assistant_reasoning_mutation_exempt_mid(&req.messages);
    let lookup = FrozenUnitLookup::Indexed(FrozenUnitIndex::new(&core.frozen_units));
    let previous = meta
        .served_output_fingerprint
        .iter()
        .map(|block| (block.block_id.as_str(), block.content_hash.as_str()))
        .collect::<HashMap<_, _>>();
    let mut units = Vec::new();
    for message in &req.messages {
        let tag = message_tag_number(message, tag_numbers);
        if message.ck.meta.synthetic
            || message.ck.role != "assistant"
            || message.mid.is_empty()
            || newest == Some(message.mid.as_str())
            || lineage_anchor_mid == Some(message.mid.as_str())
            || tag == 0
            || tag > cutoff
            || output_message_strip_unit(&lookup, "reasoning_clear", &message.mid).is_some()
            || !message.ck.content.iter().any(is_reasoning_block)
        {
            continue;
        }
        // Older sessions store an age watermark without per-message clear records.
        // Adopt a clear without invalidating the cache only if every reasoning
        // block's last-served fingerprint matches the exact cleared representation.
        // Missing evidence, still-signed content, or a native keep decision means
        // waiting for a pass that is allowed to change provider-visible bytes.
        let already_served_clear =
            output_message_strip_unit(&lookup, "native_reasoning_keep", &message.mid).is_none()
                && message
                    .ck
                    .content
                    .iter()
                    .enumerate()
                    .filter(|(_, block)| is_reasoning_block(block))
                    .all(|(index, block)| {
                        let mut cleared = block.clone();
                        cleared.kind = ck_wire::CkKind::Reasoning {
                            text: String::new(),
                            signature: None,
                        };
                        cleared.mark_modified();
                        let candidate = ServedMessage::from_message(CkWireMessage::from_parts(
                            "assistant",
                            vec![cleared],
                            None,
                            ck_wire::ProviderExtras::new(),
                            ck_wire::HarnessMeta::default(),
                        ));
                        previous
                            .get(ck_wire::block_id(&message.mid, index).as_str())
                            .copied()
                            == Some(candidate.block_fingerprints[0].0.as_str())
                    });
        if can_mutate_provider_prefix || already_served_clear {
            units.push(strip_unit("reasoning_clear", &message.mid, ""));
        }
    }
    units
}

fn replay_reasoning_clear(
    frozen_units: &FrozenUnitLookup<'_>,
    mid: &str,
    rebuilt: &mut CkWireMessage,
) {
    let Some(unit) = output_message_strip_unit(frozen_units, "reasoning_clear", mid) else {
        return;
    };
    for block in &mut rebuilt.content {
        if is_reasoning_block(block) {
            block.kind = ck_wire::CkKind::Reasoning {
                text: unit.frozen_payload.clone(),
                signature: None,
            };
            block.mark_modified();
        }
    }
    rebuilt.mark_modified();
}

pub(crate) fn reasoning_clear_mids(units: &[FrozenUnit]) -> HashSet<&str> {
    units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_clear:"))
        .collect()
}
