use async_trait::async_trait;
use conversations::{ConversationTurnSnapshot, CreateForkConversation, create_fork_conversation};
use db::{
    SqliteConversationRepository,
    conversation_repository::AgentCatalogRow,
    models::{
        conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
        conversation_event::ConversationEventRecord,
        conversation_turn::ConversationTurnRecord,
    },
};
use remote_protocol::{
    ConversationId, EventDurability, NotificationOutcome, NotificationSource,
    OfflineConversationCache, OperationId, RemoteEvent, SubscriptionBootstrap, SubscriptionId,
    SubscriptionSnapshot, TerminalNotificationSummary,
};
use uuid::Uuid;

use super::{
    ConversationCatalog, ConversationCatalogAgent, ConversationCatalogProject,
    ConversationCatalogTag, ConversationCatalogWorkspace, ConversationOutputView,
    ConversationRepository, ConversationSlashCommand, ConversationWorkspaceEntry,
    CreateChildConversationRequest, CreateConversation, CreateConversationWorkspace,
    ListRecentConversations, MAX_LIVE_EVENTS, MAX_OFFLINE_EVENTS,
};
use crate::{ApplicationError, NotificationProjector, TerminalNotificationEvidence};

pub(crate) fn catalog_agent_usable(
    enabled: bool,
    lifecycle: Option<&str>,
    authentication: Option<&str>,
) -> bool {
    if !enabled {
        return false;
    }
    let authentication = authentication.unwrap_or("").trim();
    if matches!(authentication, "not_logged_in" | "multiple_unknown") {
        return false;
    }
    match lifecycle.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("ready") => true,
        Some(_) => false,
    }
}

fn catalog_agent_from_row(row: AgentCatalogRow) -> ConversationCatalogAgent {
    let lifecycle = row.lifecycle.filter(|value| !value.is_empty());
    let authentication = row.authentication.filter(|value| !value.is_empty());
    ConversationCatalogAgent {
        id: row.agent_id,
        ready: row.enabled,
        usable: catalog_agent_usable(row.enabled, lifecycle.as_deref(), authentication.as_deref()),
        lifecycle,
        authentication,
        display_name: row.display_name.filter(|value| !value.is_empty()),
        icon_svg: row.retained_icon_svg.filter(|value| !value.is_empty()),
        current_mode: None,
        session_config: None,
        session_modes: None,
        session_config_json: None,
        session_modes_json: None,
    }
}

fn parse_json_value(raw: Option<&str>) -> Option<serde_json::Value> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn builtin_catalog_tags() -> Vec<ConversationCatalogTag> {
    vec![
        ConversationCatalogTag {
            id: "builtin:start-project-dev-server".into(),
            name: "启动项目开发服务器".into(),
            content: "分析当前项目并识别正确的开发服务器启动方式；必要时检查或安装依赖并修复基础环境问题；成功启动后验证服务可访问，再把可访问的本地 URL 直接告诉我。".into(),
        },
        ConversationCatalogTag {
            id: "builtin:review-changes".into(),
            name: "审查变更".into(),
            content: "请审查当前工作区的所有未提交代码变更。优先指出可能的 Bug、行为回归、可维护性问题、性能问题和测试缺口；按严重程度排序，尽量附上文件和行号。若没有发现问题，请明确说明未发现高风险问题，并列出仍未验证的风险。".into(),
        },
    ]
}

fn slash_commands_from_available(
    commands: &[agents::AgentAvailableCommand],
) -> Vec<ConversationSlashCommand> {
    commands
        .iter()
        .filter_map(|command| {
            let raw = command.name.trim().trim_start_matches('/');
            let (name, value) = if let Some(skill) = raw.strip_prefix('$') {
                (skill.to_string(), format!("${skill}"))
            } else {
                (raw.to_string(), format!("/{raw}"))
            };
            if name.is_empty() {
                return None;
            }
            Some(ConversationSlashCommand {
                name: name.clone(),
                description: command
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: name,
                value,
            })
        })
        .collect()
}

#[cfg(test)]
fn slash_commands_from_skills(
    skills: &[agents::skills::AgentSkillItem],
) -> Vec<ConversationSlashCommand> {
    skills
        .iter()
        .filter_map(|skill| {
            let name = skill.id.trim().trim_start_matches('/').to_string();
            if name.is_empty() {
                return None;
            }
            Some(ConversationSlashCommand {
                name: name.clone(),
                description: skill
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                kind: "skill".into(),
                source_kind: "skill".into(),
                source_id: skill.path.clone(),
                value: format!("/{name}"),
            })
        })
        .collect()
}

#[async_trait]
impl ConversationRepository for SqliteConversationRepository {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        DbConversationSummary::list_for_workspace(self.pool(), workspace_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn list_recent(
        &self,
        request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        DbConversationSummary::list_recent(
            self.pool(),
            request.since_days,
            request.project_id,
            request.limit,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn catalog(&self) -> Result<ConversationCatalog, ApplicationError> {
        let projects = self
            .catalog_projects()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .into_iter()
            .map(|project| ConversationCatalogProject {
                id: project.id,
                name: project.name,
                path: project.path,
            })
            .collect();
        let workspaces = self
            .catalog_workspaces()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .into_iter()
            .map(|row| ConversationCatalogWorkspace {
                id: row.id,
                project_id: row.project_id,
                name: row
                    .name
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| row.branch.clone()),
                branch: row.branch,
            })
            .collect();
        let mut agents = self
            .catalog_agents()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .into_iter()
            .map(catalog_agent_from_row)
            .collect::<Vec<_>>();
        for agent in &mut agents {
            if let Ok(Some(row)) = self.catalog_agent_binding(&agent.id).await {
                agent.current_mode = row.current_mode.filter(|value| !value.is_empty());
                agent.session_config = parse_json_value(
                    row.config_options_json
                        .as_deref()
                        .filter(|value| !value.is_empty() && *value != "[]"),
                );
                agent.session_modes = parse_json_value(
                    row.modes_json
                        .as_deref()
                        .filter(|value| !value.is_empty() && *value != "[]"),
                );
                agent.session_config_json = row
                    .config_options_json
                    .filter(|value| !value.is_empty() && value != "[]");
                agent.session_modes_json = row
                    .modes_json
                    .filter(|value| !value.is_empty() && value != "[]");
            }
            if agent.session_config.is_none()
                && let Ok(Some(controls)) = self.catalog_agent_capability(&agent.id).await
                && let Ok(value) = serde_json::from_str::<serde_json::Value>(&controls)
            {
                let modes = value
                    .get("modes")
                    .cloned()
                    .filter(|item| item != &serde_json::json!([]));
                let options = value
                    .get("config_options")
                    .cloned()
                    .filter(|item| item != &serde_json::json!([]));
                if agent.session_modes.is_none() {
                    agent.session_modes = modes;
                }
                agent.session_config = options;
            }
        }
        let mut tags = builtin_catalog_tags();
        if let Ok(rows) = db::models::tag::Tag::find_all(self.pool()).await {
            for row in rows {
                if tags
                    .iter()
                    .any(|tag| tag.name.eq_ignore_ascii_case(&row.tag_name))
                {
                    continue;
                }
                tags.push(ConversationCatalogTag {
                    id: row.id.to_string(),
                    name: row.tag_name,
                    content: row.content,
                });
            }
        }
        Ok(ConversationCatalog {
            projects,
            workspaces,
            agents,
            tags,
        })
    }

    async fn workspace_entries(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        let Some(root) = self
            .workspace_root(workspace_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
        else {
            return Err(ApplicationError::not_found("workspace not found"));
        };
        let path = std::path::Path::new(&root);
        if !path.is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        let read = std::fs::read_dir(path).map_err(|error| {
            ApplicationError::internal(format!("read workspace directory: {error}"))
        })?;
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            entries.push(ConversationWorkspaceEntry {
                name: name.clone(),
                path: name,
                directory,
            });
            if entries.len() >= 200 {
                break;
            }
        }
        entries.sort_by(|left, right| {
            right
                .directory
                .cmp(&left.directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn slash_commands(
        &self,
        _agent_id: String,
        _workspace_id: Option<Uuid>,
        conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        let Some(conversation_id) = conversation_id else {
            return Ok(Vec::new());
        };
        let record = db::models::conversation_event::ConversationEventRecord::latest_of_kind(
            self.pool(),
            conversation_id,
            "available_commands_updated",
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let Some(record) = record else {
            return Ok(Vec::new());
        };
        match serde_json::from_str::<agents::conversation::ConversationEvent>(
            &record.normalized_json,
        ) {
            Ok(agents::conversation::ConversationEvent::AvailableCommandsUpdated { commands }) => {
                Ok(slash_commands_from_available(&commands))
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn archive(&self, conversation_id: Uuid) -> Result<(), ApplicationError> {
        db::models::session::Session::update_status(
            self.pool(),
            conversation_id,
            db::models::session::SessionStatus::Archived,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn set_pinned(
        &self,
        conversation_id: Uuid,
        pinned: bool,
    ) -> Result<(), ApplicationError> {
        DbConversationSummary::set_pinned(self.pool(), conversation_id, pinned)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn delete(&self, conversation_id: Uuid) -> Result<(), ApplicationError> {
        DbConversationSummary::soft_delete(self.pool(), conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn rename(&self, conversation_id: Uuid, title: String) -> Result<(), ApplicationError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::bad_request("title is required"));
        }
        DbConversationSummary::set_title(self.pool(), conversation_id, trimmed)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn set_status(
        &self,
        conversation_id: Uuid,
        status: String,
    ) -> Result<(), ApplicationError> {
        let parsed = status
            .parse::<db::models::session::SessionStatus>()
            .map_err(|_| ApplicationError::bad_request(format!("unknown status {status}")))?;
        db::models::session::Session::update_status(self.pool(), conversation_id, parsed)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn create_workspace(
        &self,
        request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        let source = self
            .workspace_source_for_project(request.project_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::bad_request("这个项目还没有可复制的工作区"))?;
        let id = Uuid::new_v4();
        let branch = request
            .branch
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(source.branch);
        let name = request.name.trim().to_string();
        self.insert_workspace_from_source(id, source.id, &branch, &name)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        Ok(ConversationCatalogWorkspace {
            id,
            project_id: request.project_id,
            name,
            branch,
        })
    }

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let conversation_id = Uuid::new_v4();
        let agent_id = request.agent_id.trim();
        if agent_id.is_empty() {
            return Err(ApplicationError::bad_request("agentId is required"));
        }
        ConversationRecord::create(
            self.pool(),
            conversation_id,
            CreateConversationRecord {
                workspace_id: request.workspace_id,
                task_id: None,
                title: request.title.as_deref(),
                initial_prompt: request.initial_prompt.as_deref(),
                status: None,
                executor: Some(agent_id),
            },
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        self.set_session_agent(conversation_id, agent_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        DbConversationSummary::find_by_id(self.pool(), conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
    }

    async fn create_child(
        &self,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let agent_id = agents::AgentId::parse(&request.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let conversation_id = create_fork_conversation(
            self.pool(),
            CreateForkConversation {
                id: operation_id,
                parent_conversation_id: request.parent_conversation_id,
                agent_id,
                title: request.title,
                initial_prompt: request.initial_prompt,
                visible: request.visible,
            },
        )
        .await
        .map_err(|error| match error {
            conversations::ConversationServiceError::NotFound(message) => {
                ApplicationError::not_found(message)
            }
            conversations::ConversationServiceError::BadRequest(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::Conflict(message) => {
                ApplicationError::conflict(message)
            }
            conversations::ConversationServiceError::Internal(message) => {
                ApplicationError::internal(message)
            }
            conversations::ConversationServiceError::AuthenticationRequired(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::SessionUnavailable { message, .. } => {
                ApplicationError::bad_request(message)
            }
        })?;
        DbConversationSummary::find_by_id(self.pool(), conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
    }

    async fn output(
        &self,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        let turn = ConversationTurnRecord::latest_for_conversation(self.pool(), conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let last_sequence = self
            .max_event_sequence(conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let assistant_text = match turn.as_ref() {
            Some(turn) => {
                crate::workflow::extract_last_assistant_text(self.pool(), conversation_id, turn.id)
                    .await
                    .ok()
            }
            None => None,
        };
        Ok(ConversationOutputView {
            conversation_id,
            turn: turn.map(|turn| ConversationTurnSnapshot {
                conversation_id,
                turn_id: turn.id,
                prompt_id: turn
                    .prompt_id
                    .and_then(|value| Uuid::parse_str(&value).ok()),
                status: turn.status,
                last_sequence,
            }),
            assistant_text,
        })
    }

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let high_water_mark = self
            .max_event_sequence(conversation_uuid)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if after_sequence >= high_water_mark {
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: false,
                snapshot: (after_sequence == 0).then_some(SubscriptionSnapshot {
                    through_sequence: high_water_mark,
                    payload: serde_json::json!({ "events": [] }),
                }),
                replay: Vec::new(),
                high_water_mark,
                durability: EventDurability::Durable,
            });
        }

        let page_limit = if after_sequence == 0 {
            MAX_OFFLINE_EVENTS
        } else {
            MAX_LIVE_EVENTS
        };
        let records = ConversationEventRecord::events_since(
            self.pool(),
            conversation_uuid,
            after_sequence,
            page_limit,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(remote_event)
            .collect::<Vec<_>>();
        let delivered_through = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence.max(0));
        let (snapshot, replay) = if after_sequence == 0 {
            (
                Some(SubscriptionSnapshot {
                    through_sequence: delivered_through,
                    payload: serde_json::json!({ "events": events }),
                }),
                Vec::new(),
            )
        } else {
            (None, events)
        };
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: false,
            snapshot,
            replay,
            high_water_mark: delivered_through,
            durability: EventDurability::Durable,
        })
    }

    async fn offline_cache(
        &self,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let (high_water_mark, records) = self
            .offline_events(conversation_uuid, after_sequence, MAX_OFFLINE_EVENTS)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let confirmed_through = records
            .last()
            .map_or(after_sequence.max(0).min(high_water_mark), |record| {
                record.sequence
            });
        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(remote_event)
            .collect();
        Ok(OfflineConversationCache {
            conversation_id,
            confirmed_through,
            read_only: true,
            events,
        })
    }

    async fn terminal_notification(
        &self,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let record = self
            .latest_terminal_event(conversation_uuid)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} has no terminal event"
                ))
            })?;
        let source = self
            .automation_source(conversation_uuid)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .map_or(
                NotificationSource::Conversation { conversation_id },
                |row| NotificationSource::Automation {
                    run_id: row.0.to_string(),
                    automation_id: row.1.to_string(),
                    conversation_id: Some(conversation_id),
                },
            );
        let outcome = match record.event_kind.as_str() {
            "turn_completed" => NotificationOutcome::Completed,
            "turn_failed" => NotificationOutcome::Failed,
            "turn_cancelled" => NotificationOutcome::Cancelled,
            "turn_interrupted" => NotificationOutcome::Interrupted,
            _ => {
                return Err(ApplicationError::internal(
                    "terminal event query returned a non-terminal event",
                ));
            }
        };
        Ok(NotificationProjector::project(
            TerminalNotificationEvidence {
                source,
                outcome,
                occurred_at: record.created_at.to_rfc3339(),
                operation_id: OperationId::from_uuid(record.id),
                private_detail: Some(record.normalized_json),
            },
        ))
    }
}

fn remote_event(record: ConversationEventRecord) -> RemoteEvent {
    let mut payload: serde_json::Value = serde_json::from_str(&record.normalized_json)
        .unwrap_or_else(|_| serde_json::json!({ "unparsed": record.normalized_json }));
    if let (Some(object), Some(turn_id)) = (payload.as_object_mut(), record.turn_id) {
        let turn = serde_json::Value::String(turn_id.to_string());
        object.entry("turnId").or_insert_with(|| turn.clone());
        object.entry("turn_id").or_insert(turn);
    }
    RemoteEvent {
        sequence: record.sequence,
        kind: record.event_kind,
        payload,
    }
}

#[cfg(test)]
mod catalog_agent_usable_tests {
    use super::catalog_agent_usable;

    #[test]
    fn ready_account_is_usable() {
        assert!(catalog_agent_usable(true, Some("ready"), Some("account")));
        assert!(catalog_agent_usable(true, Some("ready"), Some("api_key")));
        assert!(catalog_agent_usable(
            true,
            Some("ready"),
            Some("not_required")
        ));
    }

    #[test]
    fn login_and_environment_failures_are_not_usable() {
        assert!(!catalog_agent_usable(
            true,
            Some("ready"),
            Some("not_logged_in")
        ));
        assert!(!catalog_agent_usable(true, Some("needs_auth"), None));
        assert!(!catalog_agent_usable(
            true,
            Some("needs_repair"),
            Some("api_key")
        ));
        assert!(!catalog_agent_usable(true, Some("uninstalled"), None));
    }

    #[test]
    fn missing_probe_does_not_block_an_enabled_agent() {
        assert!(catalog_agent_usable(true, None, None));
    }

    #[test]
    fn disabled_is_not_usable() {
        assert!(!catalog_agent_usable(false, Some("ready"), Some("account")));
    }
}

#[cfg(test)]
mod slash_commands_from_skills_tests {
    use agents::skills::{AgentSkillItem, AgentSkillScope};

    use super::{
        ConversationSlashCommand, slash_commands_from_available, slash_commands_from_skills,
    };

    #[test]
    fn maps_live_available_commands_to_slash_values() {
        let commands = slash_commands_from_available(&[agents::AgentAvailableCommand {
            name: "/compact".into(),
            description: Some("Compact context".into()),
            input_schema: None,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "compact".into(),
                description: Some("Compact context".into()),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: "compact".into(),
                value: "/compact".into(),
            }]
        );
    }

    #[test]
    fn maps_codex_dollar_skills_to_dollar_values() {
        let commands = slash_commands_from_available(&[agents::AgentAvailableCommand {
            name: "$deploy".into(),
            description: Some("Deploy skill".into()),
            input_schema: None,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "deploy".into(),
                description: Some("Deploy skill".into()),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: "deploy".into(),
                value: "$deploy".into(),
            }]
        );
    }

    #[test]
    fn maps_skill_id_and_path_to_desktop_slash_value() {
        let commands = slash_commands_from_skills(&[AgentSkillItem {
            id: "office-xlsx".into(),
            scope: AgentSkillScope::Global,
            path: "/Users/mac/.agents/skills/office-xlsx".into(),
            description: Some("Excel".into()),
            read_only: true,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "office-xlsx".into(),
                description: Some("Excel".into()),
                kind: "skill".into(),
                source_kind: "skill".into(),
                source_id: "/Users/mac/.agents/skills/office-xlsx".into(),
                value: "/office-xlsx".into(),
            }]
        );
    }
}
