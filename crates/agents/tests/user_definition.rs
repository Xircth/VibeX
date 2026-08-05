use agents::{AgentId, UserAgentDefinition, UserAgentDistributionKind};

#[test]
fn user_definition_validates_selected_distribution_and_has_a_canonical_digest() {
    let first = UserAgentDefinition::parse(
        AgentId::parse("local-reviewer").unwrap(),
        "Local Reviewer".to_string(),
        "Reviews the current workspace".to_string(),
        "1.2.3".to_string(),
        UserAgentDistributionKind::Npx,
        r#"{
          "npx": {
            "package": "local-reviewer@1.2.3",
            "env": {"SECOND": "2", "FIRST": "1"},
            "args": ["--acp"]
          }
        }"#,
    )
    .unwrap();
    let reordered = UserAgentDefinition::parse(
        AgentId::parse("local-reviewer").unwrap(),
        "Local Reviewer".to_string(),
        "Reviews the current workspace".to_string(),
        "1.2.3".to_string(),
        UserAgentDistributionKind::Npx,
        r#"{"npx":{"args":["--acp"],"package":"local-reviewer@1.2.3","env":{"FIRST":"1","SECOND":"2"}}}"#,
    )
    .unwrap();

    assert_eq!(first.definition_sha256, reordered.definition_sha256);
    assert_eq!(first.distributions_json, reordered.distributions_json);

    let missing = UserAgentDefinition::parse(
        AgentId::parse("local-reviewer").unwrap(),
        "Local Reviewer".to_string(),
        String::new(),
        "1.2.3".to_string(),
        UserAgentDistributionKind::Uvx,
        r#"{"npx":{"package":"local-reviewer@1.2.3"}}"#,
    );
    assert!(missing.unwrap_err().contains("selected uvx distribution"));
}
