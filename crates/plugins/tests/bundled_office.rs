use plugins::{ManifestSource, PackageFormat, PluginPackage, PluginService, PluginSourceKind};

#[test]
fn bundled_office_manifest_covers_pptx_docx_and_xlsx_actions() {
    let manifest = PluginService::new()
        .import_manifest(
            include_str!("../../../assets/plugins/office/manifest.vibex-plugin.json"),
            ManifestSource::Bundled,
        )
        .unwrap();

    assert_eq!(manifest.id.as_str(), "vibex.office");
    assert_eq!(manifest.dependencies[0].id.as_str(), "officecli");
    assert_eq!(manifest.dependencies[0].distributions.len(), 6);
    assert_eq!(manifest.actions.len(), 6);
    assert_eq!(manifest.skills.len(), 3);
    let embedded_skills = [
        (
            "office-pptx",
            include_str!("../../../assets/plugins/office/skills/office-pptx/SKILL.md"),
        ),
        (
            "office-docx",
            include_str!("../../../assets/plugins/office/skills/office-docx/SKILL.md"),
        ),
        (
            "office-xlsx",
            include_str!("../../../assets/plugins/office/skills/office-xlsx/SKILL.md"),
        ),
    ];
    for skill in &manifest.skills {
        let source = embedded_skills
            .iter()
            .find_map(|(id, source)| (*id == skill.id.as_str()).then_some(*source))
            .expect("every declared bundled skill is embedded");
        assert!(source.starts_with("---\n"));
    }
    let media_types = manifest
        .actions
        .iter()
        .flat_map(|action| {
            action
                .artifact_intent
                .iter()
                .flat_map(|intent| intent.media_types.iter())
        })
        .collect::<Vec<_>>();
    assert!(
        media_types
            .iter()
            .any(|media_type| media_type.ends_with("presentationml.presentation"))
    );
    assert!(
        media_types
            .iter()
            .any(|media_type| media_type.ends_with("wordprocessingml.document"))
    );
    assert!(
        media_types
            .iter()
            .any(|media_type| media_type.ends_with("spreadsheetml.sheet"))
    );
}

#[test]
fn bundled_office_is_a_portable_skill_first_package() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package =
        PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("portable Office package");

    assert_eq!(package.id.as_str(), "vibex.office");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert_eq!(package.skills.len(), 3);
    assert_eq!(package.runtimes[0].command, "officecli");
}
