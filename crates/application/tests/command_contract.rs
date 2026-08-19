use application::{
    ApplicationCore, ApplicationDomainPort, CommandRegistry, ConversationCatalog,
    ConversationCatalogProject, ConversationCatalogWorkspace, ConversationRepository,
    DomainCommand, Principal, RegisteredCommand,
};
use async_trait::async_trait;
use remote_protocol::{ErrorCode, OperationId};
use serde_json::json;
use uuid::Uuid;

struct EmptyConversations;

struct CatalogDomain;

#[test]
fn agent_skill_listing_is_available_through_the_application_domain() {
    let command = "list_agent_skills"
        .parse::<DomainCommand>()
        .expect("agent Skill listing should parse");
    assert_eq!(command.required_scope(), "application.call");
}

#[test]
fn product_plugin_inventory_and_file_opener_are_remote_read_contracts() {
    for name in [
        "plugin_control_catalog",
        "plugin_contribution_catalog",
        "plugin_resolve_file_opener",
    ] {
        let command = name.parse::<DomainCommand>().expect("plugin read command");
        assert_eq!(command.required_scope(), "plugin.read");
    }
    assert_eq!(
        "plugin_control_set_enabled"
            .parse::<DomainCommand>()
            .expect("plugin write command")
            .required_scope(),
        "plugin.write"
    );
    assert_eq!(
        "plugin_control_grant_permissions"
            .parse::<DomainCommand>()
            .expect("permission write command")
            .required_scope(),
        "plugin.write"
    );
}

#[test]
fn app_extension_host_uses_a_dedicated_remote_scope() {
    for name in [
        "plugin_surface_open",
        "plugin_surface_invoke",
        "plugin_surface_revoke",
    ] {
        assert_eq!(
            name.parse::<DomainCommand>()
                .expect("App surface command")
                .required_scope(),
            "plugin.surface"
        );
    }
}

#[async_trait]
impl ApplicationDomainPort for CatalogDomain {
    async fn execute(
        &self,
        _principal: &Principal,
        command: DomainCommand,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, application::ApplicationError> {
        assert_eq!(command, DomainCommand::PluginActionCatalog);
        assert_eq!(args, json!({}));
        Ok(json!({"plugin": {"id": "vibex.office"}}))
    }
}

#[async_trait]
impl ConversationRepository for EmptyConversations {
    async fn list_for_workspace(
        &self,
        _workspace_id: Uuid,
    ) -> Result<Vec<application::ConversationSummary>, application::ApplicationError> {
        Ok(Vec::new())
    }

    async fn create(
        &self,
        _request: application::CreateConversation,
    ) -> Result<application::ConversationSummary, application::ApplicationError> {
        unreachable!("command contract does not create conversations")
    }

    async fn attach(
        &self,
        _subscription_id: remote_protocol::SubscriptionId,
        _conversation_id: remote_protocol::ConversationId,
        _after_sequence: i64,
    ) -> Result<remote_protocol::SubscriptionBootstrap, application::ApplicationError> {
        unreachable!("command contract does not attach")
    }
}

#[tokio::test]
async fn local_adapter_matches_the_registered_serde_contract() {
    let core = ApplicationCore::new(EmptyConversations);
    let registry = CommandRegistry::new(core);
    let operation_id =
        OperationId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f55").expect("operation id");

    let response = registry
        .execute(
            &Principal::local_desktop(),
            RegisteredCommand::ConversationList,
            operation_id,
            json!({"workspaceId": Uuid::nil()}),
        )
        .await
        .expect("registered command");

    let wire = serde_json::to_value(&response).expect("serialize response");
    assert_eq!(
        wire,
        json!({
            "operation_id": operation_id,
            "data": []
        })
    );
    assert_eq!(
        serde_json::from_value::<remote_protocol::CommandResponse<serde_json::Value>>(wire)
            .expect("protocol round trip"),
        response
    );
}

#[tokio::test]
async fn recent_conversation_list_and_catalog_are_registered() {
    let registry = CommandRegistry::new(ApplicationCore::new(EmptyConversations));
    let operation_id = OperationId::new();
    let recent = registry
        .execute_name(
            &Principal::local_desktop(),
            "conversation_list_recent",
            operation_id,
            json!({"sinceDays": 3, "limit": 20}),
        )
        .await
        .expect("list recent");
    assert_eq!(recent.data, json!([]));
    let catalog = registry
        .execute_name(
            &Principal::local_desktop(),
            "conversation_catalog",
            operation_id,
            json!({}),
        )
        .await
        .expect("catalog");
    assert_eq!(catalog.data["projects"], json!([]));
}

#[test]
fn conversation_catalog_wire_uses_camel_case() {
    let catalog = ConversationCatalog {
        projects: vec![ConversationCatalogProject {
            id: Uuid::nil(),
            name: "VibeX".into(),
            path: "/tmp/app".into(),
        }],
        workspaces: vec![ConversationCatalogWorkspace {
            id: Uuid::nil(),
            project_id: Uuid::nil(),
            name: "main".into(),
            branch: "main".into(),
        }],
        agents: vec![],
    };
    let value = serde_json::to_value(&catalog).expect("serialize catalog");
    assert_eq!(value["projects"][0]["path"], "/tmp/app");
    assert_eq!(value["workspaces"][0]["projectId"], Uuid::nil().to_string());
    assert!(value["workspaces"][0].get("project_id").is_none());
}

#[tokio::test]
async fn registry_rejects_unregistered_commands_with_the_same_operation_id() {
    let registry = CommandRegistry::new(ApplicationCore::new(EmptyConversations));
    let operation_id = OperationId::new();
    let error = registry
        .execute_name(
            &Principal::local_desktop(),
            "arbitrary_reflection",
            operation_id,
            json!({}),
        )
        .await
        .expect_err("unregistered commands must be rejected");

    assert_eq!(error.code, ErrorCode::NotFound);
    assert_eq!(error.operation_id, operation_id);
}

#[tokio::test]
async fn registered_product_command_uses_the_application_domain_port() {
    let registry = CommandRegistry::new(ApplicationCore::with_domains(
        EmptyConversations,
        std::sync::Arc::new(CatalogDomain),
    ));
    let operation_id = OperationId::new();
    let response = registry
        .execute_name(
            &Principal::remote(
                "web-user",
                ["plugin.read".to_string(), "plugin.write".to_string()],
            ),
            "plugin_action_catalog",
            operation_id,
            json!({}),
        )
        .await
        .expect("registered product command");

    assert_eq!(response.operation_id, operation_id);
    assert_eq!(response.data["plugin"]["id"], "vibex.office");
}
