use std::collections::HashSet;

use automation::{BuiltinTemplateCatalog, TurnLaunchSpec};

#[test]
fn all_builtin_templates_are_valid_drafts() {
    let templates = BuiltinTemplateCatalog::all();

    assert_eq!(templates.len(), 7);
    assert_eq!(
        templates
            .iter()
            .map(|template| template.id.as_str())
            .collect::<HashSet<_>>()
            .len(),
        7
    );
    for template in templates {
        let launch = TurnLaunchSpec::from_automation_draft(template.draft.launch.clone())
            .unwrap_or_else(|error| panic!("template {} is invalid: {error}", template.id));
        launch.validate().expect("same public validator");
        assert!(
            !template.draft.name.trim().is_empty(),
            "templates are ordinary named drafts"
        );
    }
}
