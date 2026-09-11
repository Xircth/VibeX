use plugins::{PluginPackage, PluginSourceKind};

fn bundled() -> PluginPackage {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/science");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("science package")
}

#[test]
fn bundled_science_plugin_is_a_domain_gated_skill_library() {
    let package = bundled();
    assert_eq!(package.id.as_str(), "vibex.science");
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert_eq!(package.version, "1.0.0");
    assert_eq!(package.name, "科学研究");
    assert_eq!(
        package.summary,
        "146 项科研技能，按 10 个领域分组。默认只注入「通用科研方法」13 项，其余领域在插件配置中按需开启。"
    );
    assert!(package.entrypoints.worker.is_none());
    assert!(
        package.warnings.is_empty(),
        "the package must parse cleanly: {:?}",
        package.warnings
    );
    assert_eq!(package.skills.len(), 146);
    assert_eq!(
        package
            .enabled_skills()
            .map(|skill| skill.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "scientific-brainstorming",
            "hypothesis-generation",
            "experimental-design",
            "statistical-power",
            "statistical-analysis",
            "exploratory-data-analysis",
            "scientific-visualization",
            "scientific-critical-thinking",
            "paper-lookup",
            "peer-review",
            "citation-management",
            "scholar-evaluation",
            "scientific-schematics",
        ]
    );
    assert!(
        package
            .enabled_skills()
            .all(|skill| skill.domain.as_deref() == Some("general")),
        "default config must project only the general domain"
    );
    assert_eq!(package.config["domains"]["general"], true);
    assert_eq!(package.config["domains"]["genomics"], false);
}
