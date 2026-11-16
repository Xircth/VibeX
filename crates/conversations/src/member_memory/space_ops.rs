use super::*;

pub(super) fn build_memory_summary_card(
    is_direct: bool,
    facts: &[MemberFact],
    activity: &[ActivityEntry],
    topics: &[MemoryTopicRecord],
    indexed_collection_notes: &[String],
) -> MemorySummaryCard {
    let mut sections = Vec::new();
    let char_count: usize = facts.iter().map(|f| f.content.chars().count()).sum();

    if is_direct {
        let global_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope == "global")
            .take(5)
            .map(|f| f.content.clone())
            .collect();
        if !global_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "global".to_string(),
                title: "全局协作规范".to_string(),
                items: global_items,
            });
        }
        let private_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope == "private")
            .take(5)
            .map(|f| f.content.clone())
            .collect();
        if !private_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "private".to_string(),
                title: "私聊偏好与约定".to_string(),
                items: private_items,
            });
        }
        let thread_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope.starts_with("thread:"))
            .take(4)
            .map(|f| f.content.clone())
            .collect();
        if !thread_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "threads".to_string(),
                title: "群组专项经验".to_string(),
                items: thread_items,
            });
        }
    } else {
        let group_items: Vec<String> = facts.iter().take(6).map(|f| f.content.clone()).collect();
        if !group_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "group".to_string(),
                title: "本群共享共识与规范".to_string(),
                items: group_items,
            });
        }
    }

    if !activity.is_empty() {
        sections.push(MemorySummarySection {
            id: "activity".to_string(),
            title: "近期关键动态".to_string(),
            items: activity.iter().take(3).map(|a| a.summary.clone()).collect(),
        });
    }

    let mut index_items: Vec<String> = topics
        .iter()
        .take(5)
        .map(|t| format!("[[topic:{}]] — {}", t.topic, t.summary))
        .collect();
    index_items.extend(indexed_collection_notes.iter().take(5).cloned());
    if !index_items.is_empty() {
        sections.push(MemorySummarySection {
            id: "index".to_string(),
            title: "主题与收藏知识索引".to_string(),
            items: index_items,
        });
    }

    MemorySummaryCard {
        sections,
        char_count,
        budget_chars: MEMORY_MAIN_MAX_CHARS,
        updated_at: now(),
    }
}

/// List `[[collection:...]]` index lines for items in `space_id` that have not
/// been excluded via `index_excluded.json`.
pub async fn list_indexed_space_collection_pointers(
    pool: &SqlitePool,
    space_id: &str,
) -> Vec<String> {
    let excluded = read_excluded_collection_ids(space_id);
    let collection_rows: Vec<(String, String, String)> = sqlx::query_as(
        r#"SELECT id, file_name, note
           FROM collaboration_space_collection_items
           WHERE space_id = ?
           ORDER BY created_at DESC LIMIT 40"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    collection_rows
        .into_iter()
        .filter(|(id, _, _)| !excluded.iter().any(|ex| ex == id))
        .map(|(_, file_name, note)| {
            if note.trim().is_empty() {
                format!("[[collection:{file_name}]]")
            } else {
                format!("[[collection:{file_name}]] — {}", note.trim())
            }
        })
        .collect()
}

/// Refresh `~/.dimo/spaces/<safe_space>/MEMORY.md` (`## Index` section) and `summary.json`
/// while preserving `MEMORY.md`'s existing entries as the single source of truth.
pub async fn sync_space_memory_files(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Result<MemorySummaryCard, CollaborationError> {
    let member_id = resolve_member_id_from_space(space_id, explicit_member_id);
    let is_direct = space_id.starts_with("direct:") || member_id.is_some();
    let parsed = read_space_memory_parsed(space_id, member_id.as_deref());
    let facts = if let Some(ref mid) = member_id {
        list_facts(pool, mid, None).await.unwrap_or_default()
    } else {
        parsed.entries.iter().map(|e| e.fact.clone()).collect()
    };
    let activity = if let Some(ref mid) = member_id {
        list_activity(pool, mid, true, 10).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let topics = list_space_topics(space_id).unwrap_or_default();
    let indexed_collection_notes = list_indexed_space_collection_pointers(pool, space_id).await;

    let summary = build_memory_summary_card(
        is_direct,
        &facts,
        &activity,
        &topics,
        &indexed_collection_notes,
    );

    let root = space_memory_root_dir(space_id);
    if std::fs::create_dir_all(&root).is_ok() {
        let rendered =
            render_memory_markdown_with_index(&parsed.lines, &topics, &indexed_collection_notes);
        let _ = write_memory_file_atomic(space_id, &rendered);
        if let Ok(summary_bytes) = serde_json::to_vec_pretty(&summary) {
            let _ = std::fs::write(space_summary_path(space_id), summary_bytes);
        }
    }

    Ok(summary)
}

/// Complete view of a space's memory (Assistant `direct:<member_id>` or Group `<space_id>`).
pub async fn view_space_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Result<SpaceMemoryView, CollaborationError> {
    let member_id = resolve_member_id_from_space(space_id, explicit_member_id);
    let summary = sync_space_memory_files(pool, space_id, member_id.as_deref()).await?;
    let facts = if let Some(ref mid) = member_id {
        list_facts(pool, mid, None).await?
    } else {
        list_thread_facts(pool, space_id).await?
    };
    let activity = if let Some(ref mid) = member_id {
        list_activity(pool, mid, true, 30).await?
    } else {
        sqlx::query_as::<_, ActivityEntry>(
            r#"SELECT id, member_id, thread_id, summary, private != 0 AS private, created_at
               FROM member_activity
               WHERE thread_id = ? AND private = 0
               ORDER BY id DESC LIMIT 30"#,
        )
        .bind(space_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };
    let topics = list_space_topics(space_id).unwrap_or_default();
    let journal = list_memory_journal(space_id, 50);
    let excluded_collection_ids = read_excluded_collection_ids(space_id);

    Ok(SpaceMemoryView {
        space_id: space_id.to_string(),
        member_id,
        memory_file_path: space_memory_file_path(space_id)
            .to_string_lossy()
            .replace('\\', "/"),
        summary,
        facts,
        activity,
        topics,
        journal,
        excluded_collection_ids,
    })
}

/// Add a fact from the UI panel for either an assistant (`direct:<member_id>`) or a group (`<space_id>`).
pub async fn add_space_fact(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    content: &str,
    raw_scope: Option<&str>,
) -> Result<MemberFact, CollaborationError> {
    let member_id = resolve_writer_member_for_space(pool, space_id, explicit_member_id).await?;
    let is_direct = resolve_member_id_from_space(space_id, explicit_member_id).is_some();
    let scope = match raw_scope.map(str::trim).filter(|s| !s.is_empty()) {
        Some("global") => FactScope::Global,
        Some("private") => FactScope::Private,
        Some("thread" | "group") => FactScope::Thread(space_id.to_string()),
        Some(other) => FactScope::parse(other)?,
        None => {
            if is_direct {
                FactScope::Private
            } else {
                FactScope::Thread(space_id.to_string())
            }
        }
    };
    let source_thread = if matches!(scope, FactScope::Thread(_)) {
        let has_thread: Option<String> =
            sqlx::query_scalar("SELECT id FROM collaboration_threads WHERE id = ? LIMIT 1")
                .bind(space_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
        has_thread
    } else {
        None
    };
    create_fact(
        pool,
        &member_id,
        content,
        &scope,
        source_thread.as_deref(),
        "user",
    )
    .await
}

/// Distill a chat message bubble into the Space's `MEMORY.md`, using the active
/// [`MemoryReviewModel`] (`add` / `edit` / `remove`) when available.
pub async fn distill_message_to_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    message_text: &str,
    raw_scope: Option<&str>,
) -> Result<MemberFact, CollaborationError> {
    if let Some(model) = active_memory_review_model() {
        let member_id = resolve_writer_member_for_space(pool, space_id, explicit_member_id).await?;
        let is_private = resolve_member_id_from_space(space_id, explicit_member_id).is_some();
        let (entries, memory_chars) =
            collect_numbered_space_entries(space_id, &member_id, is_private);
        let prompt = MemoryReviewPrompt {
            space_id: space_id.to_string(),
            member_id: member_id.clone(),
            conversation_id: None,
            system_prompt: build_review_system_prompt(&member_id, space_id, is_private),
            user_prompt: build_review_user_prompt(
                space_id,
                &entries,
                memory_chars,
                &[],
                &[format!("Message: {}", message_text.trim())],
            ),
        };
        if let Ok(raw) = model.complete_review(&prompt).await
            && let Ok(changes) = parse_review_response(&raw)
            && !changes.is_empty()
        {
            let applied =
                apply_review_changes(pool, space_id, &member_id, is_private, &entries, &changes)
                    .await?;
            if let Some(first_fid) = applied.iter().find_map(|c| c.fact_id) {
                let facts = if is_private {
                    list_facts(pool, &member_id, None).await?
                } else {
                    list_thread_facts(pool, space_id).await?
                };
                if let Some(found) = facts.into_iter().find(|f| f.id == first_fid) {
                    return Ok(found);
                }
            }
        }
    }

    let condensed = first_sentences(message_text, 2, MEMORY_ENTRY_MAX_CHARS).unwrap_or_else(|| {
        message_text
            .trim()
            .chars()
            .take(MEMORY_ENTRY_MAX_CHARS)
            .collect()
    });
    add_space_fact(pool, space_id, explicit_member_id, &condensed, raw_scope).await
}

/// Interactive natural-language Q&A and instruction editing for the UI Memory Bar (DS-Bot `memory-ask`).
pub async fn ask_space_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    prompt: &str,
) -> Result<MemoryAskResponse, CollaborationError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(bad("prompt is required"));
    }

    let mut changes = Vec::new();
    let lower = trimmed.to_ascii_lowercase();

    // 1. Check for explicit ADD instruction ("记住：...", "添加：...", "新增：...", "remember ...", "+ ...")
    let add_payload = trimmed
        .strip_prefix("记住：")
        .or_else(|| trimmed.strip_prefix("记住:"))
        .or_else(|| trimmed.strip_prefix("添加记忆："))
        .or_else(|| trimmed.strip_prefix("添加记忆:"))
        .or_else(|| trimmed.strip_prefix("添加："))
        .or_else(|| trimmed.strip_prefix("添加:"))
        .or_else(|| trimmed.strip_prefix("新增："))
        .or_else(|| trimmed.strip_prefix("新增:"))
        .or_else(|| trimmed.strip_prefix("+ "))
        .or_else(|| {
            if lower.starts_with("remember:") || lower.starts_with("remember ") {
                Some(trimmed[9..].trim())
            } else {
                None
            }
        });

    if let Some(to_add) = add_payload.map(str::trim).filter(|s| !s.is_empty()) {
        let fact = add_space_fact(pool, space_id, explicit_member_id, to_add, None).await?;
        changes.push(MemoryAskChange {
            op: "add".to_string(),
            fact_id: Some(fact.id),
            text: fact.content.clone(),
        });
        let view = view_space_memory(pool, space_id, explicit_member_id).await?;
        return Ok(MemoryAskResponse {
            reply: format!("已记住：{}", fact.content),
            changes,
            matched_facts: vec![fact],
            view,
        });
    }

    // 2. Check for explicit REMOVE / FORGET instruction ("忘掉...", "忘记...", "删除...", "移除...", "forget ...", "- ...")
    let remove_payload = trimmed
        .strip_prefix("忘掉：")
        .or_else(|| trimmed.strip_prefix("忘掉:"))
        .or_else(|| trimmed.strip_prefix("忘掉"))
        .or_else(|| trimmed.strip_prefix("忘记："))
        .or_else(|| trimmed.strip_prefix("忘记:"))
        .or_else(|| trimmed.strip_prefix("忘记"))
        .or_else(|| trimmed.strip_prefix("删除记忆"))
        .or_else(|| trimmed.strip_prefix("删除"))
        .or_else(|| trimmed.strip_prefix("移除"))
        .or_else(|| trimmed.strip_prefix("- "))
        .or_else(|| {
            if lower.starts_with("forget ") {
                Some(trimmed[7..].trim())
            } else {
                None
            }
        });

    if let Some(raw_target) = remove_payload.map(str::trim).filter(|s| !s.is_empty()) {
        let current_view = view_space_memory(pool, space_id, explicit_member_id).await?;
        let target_id = raw_target
            .trim_start_matches('#')
            .split_whitespace()
            .next()
            .and_then(|tok| tok.parse::<i64>().ok());
        let matched = if let Some(fid) = target_id {
            current_view.facts.iter().find(|f| f.id == fid).cloned()
        } else {
            let clean_kw = raw_target
                .trim_start_matches("关于")
                .trim_end_matches("的记忆")
                .trim();
            current_view
                .facts
                .iter()
                .find(|f| f.content.contains(clean_kw))
                .cloned()
        };
        if let Some(target_fact) = matched {
            delete_fact(pool, &target_fact.member_id, target_fact.id).await?;
            changes.push(MemoryAskChange {
                op: "remove".to_string(),
                fact_id: Some(target_fact.id),
                text: target_fact.content.clone(),
            });
            let view = view_space_memory(pool, space_id, explicit_member_id).await?;
            return Ok(MemoryAskResponse {
                reply: format!("已移除记忆 #{}：{}", target_fact.id, target_fact.content),
                changes,
                matched_facts: Vec::new(),
                view,
            });
        }
        return Ok(MemoryAskResponse {
            reply: format!("未找到与「{raw_target}」匹配的记忆条目，未执行删除。"),
            changes,
            matched_facts: Vec::new(),
            view: current_view,
        });
    }

    // 3. Check for REPLACE / EDIT instruction ("把 #1 改成 ...", "把 xxx 改成 yyy")
    if let Some(rest) = trimmed.strip_prefix("把")
        && let Some((left, right)) = rest
            .split_once("改成：")
            .or_else(|| rest.split_once("改成:"))
            .or_else(|| rest.split_once("改成"))
            .or_else(|| rest.split_once("替换为"))
            .or_else(|| rest.split_once("修改为"))
    {
        let left = left.trim();
        let right = right.trim();
        if !left.is_empty() && !right.is_empty() {
            let current_view = view_space_memory(pool, space_id, explicit_member_id).await?;
            let target_id = left.trim_start_matches('#').parse::<i64>().ok();
            let matched = if let Some(fid) = target_id {
                current_view.facts.iter().find(|f| f.id == fid).cloned()
            } else {
                current_view
                    .facts
                    .iter()
                    .find(|f| f.content.contains(left))
                    .cloned()
            };
            if let Some(target_fact) = matched {
                let updated = update_fact(
                    pool,
                    &target_fact.member_id,
                    target_fact.id,
                    Some(right),
                    None,
                )
                .await?;
                changes.push(MemoryAskChange {
                    op: "edit".to_string(),
                    fact_id: Some(updated.id),
                    text: updated.content.clone(),
                });
                let view = view_space_memory(pool, space_id, explicit_member_id).await?;
                return Ok(MemoryAskResponse {
                    reply: format!("已将记忆 #{} 更新为：{}", updated.id, updated.content),
                    changes,
                    matched_facts: vec![updated],
                    view,
                });
            }
            return Ok(MemoryAskResponse {
                reply: format!("未找到与「{left}」匹配的记忆条目，无法修改。"),
                changes,
                matched_facts: Vec::new(),
                view: current_view,
            });
        }
    }

    // 4. Default: Natural-language search / Q&A across facts, topics, and activity
    let view = view_space_memory(pool, space_id, explicit_member_id).await?;
    let terms = tokenize(trimmed);
    let matched_facts: Vec<MemberFact> = if terms.is_empty() {
        view.facts.iter().take(5).cloned().collect()
    } else {
        let docs: Vec<Vec<String>> = view.facts.iter().map(|f| tokenize(&f.content)).collect();
        let scores = bm25(&docs, &terms);
        let mut ranked: Vec<(f64, MemberFact)> = view
            .facts
            .iter()
            .cloned()
            .zip(scores)
            .filter(|(_, s)| *s > 0.0)
            .map(|(f, s)| (s, f))
            .collect();
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
        ranked.into_iter().take(6).map(|(_, f)| f).collect()
    };

    let matched_topics: Vec<&MemoryTopicRecord> = view
        .topics
        .iter()
        .filter(|t| {
            terms.iter().any(|term| {
                t.topic.to_lowercase().contains(term)
                    || t.title.to_lowercase().contains(term)
                    || t.content.to_lowercase().contains(term)
            })
        })
        .collect();

    let reply = if matched_facts.is_empty() && matched_topics.is_empty() {
        if view.facts.is_empty() && view.topics.is_empty() {
            "当前空间还没有记录任何长期记忆。你可以输入「记住：…」直接添加规则。".to_string()
        } else {
            format!(
                "未找到与「{}」直接匹配的记忆（当前共有 {} 条核心记忆、{} 个主题文档）。你可以输入「记住：…」新增，或输入「把 #ID 改成 …」修改。",
                trimmed,
                view.facts.len(),
                view.topics.len()
            )
        }
    } else {
        let mut parts = Vec::new();
        if !matched_facts.is_empty() {
            let bullets = matched_facts
                .iter()
                .map(|f| format!("• (#{}) {}", f.id, f.content))
                .collect::<Vec<_>>()
                .join("\n");
            parts.push(format!(
                "找到 {} 条相关记忆：\n{}",
                matched_facts.len(),
                bullets
            ));
        }
        if !matched_topics.is_empty() {
            let t_bullets = matched_topics
                .iter()
                .map(|t| format!("• [[topic:{}]] — {}", t.topic, t.summary))
                .collect::<Vec<_>>()
                .join("\n");
            parts.push(format!("关联主题文档：\n{t_bullets}"));
        }
        parts.join("\n\n")
    };

    Ok(MemoryAskResponse {
        reply,
        changes,
        matched_facts,
        view,
    })
}

pub(super) fn input_optional_text(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        input
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

pub(super) fn input_required_text(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<String, CollaborationError> {
    input_optional_text(input, keys).ok_or_else(|| {
        let field = keys.first().copied().unwrap_or("field");
        bad(format!("{field} is required"))
    })
}

pub(super) fn resolve_space_and_member_input(
    input: &serde_json::Value,
) -> Result<(String, Option<String>), CollaborationError> {
    let member_id = input_optional_text(input, &["memberId", "member_id"]);
    let space_id = input_optional_text(input, &["spaceId", "space_id"])
        .or_else(|| member_id.as_ref().map(|m| format!("direct:{m}")))
        .ok_or_else(|| bad("spaceId or memberId is required"))?;
    Ok((space_id, member_id))
}

pub(super) async fn resolve_fact_owner_input(
    _pool: &SqlitePool,
    input: &serde_json::Value,
    fact_id: i64,
) -> Result<String, CollaborationError> {
    if let Some(mid) = input_optional_text(input, &["memberId", "member_id"]) {
        return Ok(mid);
    }
    if let Some(space_id) = input_optional_text(input, &["spaceId", "space_id"]) {
        if let Some(mid) = space_id.strip_prefix("direct:")
            && !mid.trim().is_empty()
        {
            return Ok(mid.trim().to_string());
        }
        let parsed = read_space_memory_parsed(&space_id, None);
        if let Some(entry) = parsed.entries.into_iter().find(|e| e.fact.id == fact_id) {
            return Ok(entry.fact.member_id);
        }
    }
    if let Some(map) = MEMBER_KNOWN_SPACES.get()
        && let Ok(guard) = map.lock()
    {
        for (member_id, spaces) in guard.iter() {
            for space_id in spaces {
                let parsed = read_space_memory_parsed(space_id, Some(member_id));
                if let Some(entry) = parsed.entries.into_iter().find(|e| e.fact.id == fact_id) {
                    return Ok(entry.fact.member_id);
                }
            }
        }
    }
    Err(CollaborationError::new(
        "not_found",
        "memory fact was not found",
    ))
}

pub(super) fn input_fact_id(input: &serde_json::Value) -> Result<i64, CollaborationError> {
    ["factId", "fact_id", "id"]
        .iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_i64))
        .ok_or_else(|| bad("factId is required"))
}

/// Execute a `space.memory.*` or `member.memory.*` host operation and return `(payload, changed_space_and_member)`.
pub async fn execute_space_memory_op(
    pool: &SqlitePool,
    op: &str,
    input: &serde_json::Value,
) -> Result<(serde_json::Value, Option<(String, Option<String>)>), CollaborationError> {
    match op {
        "list" => {
            let member_id = input_required_text(input, &["memberId", "member_id"])?;
            let scope = input_optional_text(input, &["scope"])
                .map(|raw| FactScope::parse(&raw))
                .transpose()?;
            let facts = list_facts(pool, &member_id, scope.as_ref()).await?;
            Ok((
                serde_json::json!({ "memberId": member_id, "facts": facts }),
                None,
            ))
        }
        "update" => {
            let fact_id = input_fact_id(input)?;
            let member_id = resolve_fact_owner_input(pool, input, fact_id).await?;
            let content = input_optional_text(input, &["content"]);
            let scope = input_optional_text(input, &["scope"])
                .map(|raw| FactScope::parse(&raw))
                .transpose()?;
            let fact = update_fact(
                pool,
                &member_id,
                fact_id,
                content.as_deref(),
                scope.as_ref(),
            )
            .await?;
            let changed = input_optional_text(input, &["spaceId", "space_id"])
                .map(|space_id| (space_id, Some(member_id.clone())));
            Ok((
                serde_json::json!({ "memberId": member_id, "fact": fact }),
                changed,
            ))
        }
        "delete" => {
            let fact_id = input_fact_id(input)?;
            let member_id = resolve_fact_owner_input(pool, input, fact_id).await?;
            let deleted = delete_fact(pool, &member_id, fact_id).await?;
            let changed = input_optional_text(input, &["spaceId", "space_id"])
                .map(|space_id| (space_id, Some(member_id.clone())));
            Ok((
                serde_json::json!({ "memberId": member_id, "factId": fact_id, "deleted": deleted }),
                changed,
            ))
        }
        "activity_list" => {
            let member_id = input_required_text(input, &["memberId", "member_id"])?;
            let limit = input
                .get("limit")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 500) as usize;
            let activity = list_activity(pool, &member_id, true, limit).await?;
            Ok((
                serde_json::json!({ "memberId": member_id, "activity": activity }),
                None,
            ))
        }
        "view" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let view = view_space_memory(pool, &space_id, member_id.as_deref()).await?;
            let val = serde_json::to_value(view).map_err(|e| {
                CollaborationError::new("conversation_control_failed", e.to_string())
            })?;
            Ok((val, None))
        }
        "add" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let content = input_required_text(input, &["content", "text"])?;
            let scope = input_optional_text(input, &["scope"]);
            let fact = add_space_fact(
                pool,
                &space_id,
                member_id.as_deref(),
                &content,
                scope.as_deref(),
            )
            .await?;
            let view = view_space_memory(pool, &space_id, member_id.as_deref()).await?;
            Ok((
                serde_json::json!({ "fact": fact, "view": view }),
                Some((space_id, member_id)),
            ))
        }
        "write_topic" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let title = input_optional_text(input, &["title"]);
            let content = input_required_text(input, &["content", "text"])?;
            let record = write_space_topic(&space_id, &topic, title.as_deref(), &content, "user")?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            Ok((
                serde_json::json!({ "topic": record }),
                Some((space_id, member_id)),
            ))
        }
        "read_topic" => {
            let (space_id, _member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let record = read_space_topic(&space_id, &topic)?;
            Ok((serde_json::json!({ "topic": record }), None))
        }
        "delete_topic" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let deleted = delete_space_topic(&space_id, &topic, "user")?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            Ok((
                serde_json::json!({ "topic": topic, "deleted": deleted }),
                Some((space_id, member_id)),
            ))
        }
        "toggle_collection_index" => {
            let member_id = input_optional_text(input, &["memberId", "member_id"]);
            let space_id = input_required_text(input, &["spaceId", "space_id"])?;
            let item_id = input_required_text(input, &["itemId", "item_id"])?;
            let indexed = input.get("indexed").and_then(serde_json::Value::as_bool);
            let now_indexed = toggle_collection_item_indexed(&space_id, &item_id, indexed)?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            let excluded = read_excluded_collection_ids(&space_id);
            Ok((
                serde_json::json!({
                    "spaceId": space_id,
                    "itemId": item_id,
                    "indexed": now_indexed,
                    "excludedCollectionIds": excluded,
                }),
                Some((space_id, member_id)),
            ))
        }
        "ask" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let prompt = input_required_text(input, &["prompt", "query", "text"])?;
            let res = ask_space_memory(pool, &space_id, member_id.as_deref(), &prompt).await?;
            let changed = (!res.changes.is_empty()).then_some((space_id, member_id));
            let val = serde_json::to_value(res).map_err(|e| {
                CollaborationError::new("conversation_control_failed", e.to_string())
            })?;
            Ok((val, changed))
        }
        "distill_message" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let content = input_required_text(input, &["content", "text", "message"])?;
            let scope = input_optional_text(input, &["scope"]);
            let fact = distill_message_to_memory(
                pool,
                &space_id,
                member_id.as_deref(),
                &content,
                scope.as_deref(),
            )
            .await?;
            Ok((
                serde_json::json!({ "fact": fact }),
                Some((space_id, member_id)),
            ))
        }
        _ => Err(bad(format!("unknown space memory op: {op}"))),
    }
}
