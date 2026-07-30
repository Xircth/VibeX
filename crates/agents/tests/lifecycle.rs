use agents::{
    AgentId, ComponentOwnership, LifecycleAction, LifecycleBlockReason, LifecycleComponent,
    LifecycleFacts, LifecycleService,
};

fn facts() -> LifecycleFacts {
    LifecycleFacts {
        agent_id: AgentId::parse("vendor-agent").unwrap(),
        built_in: false,
        active_acp_processes: 0,
        in_flight_turns: 0,
        queued_or_running_operations: 0,
        components: vec![
            LifecycleComponent {
                component_id: "managed".to_string(),
                ownership: ComponentOwnership::Managed,
                shared_reference_count: 0,
            },
            LifecycleComponent {
                component_id: "external".to_string(),
                ownership: ComponentOwnership::External,
                shared_reference_count: 0,
            },
            LifecycleComponent {
                component_id: "node".to_string(),
                ownership: ComponentOwnership::Shared,
                shared_reference_count: 2,
            },
        ],
    }
}

#[test]
fn uninstall_or_remove_is_blocked_by_live_process() {
    let service = LifecycleService;
    for mut blocked in [
        LifecycleFacts {
            active_acp_processes: 1,
            ..facts()
        },
        LifecycleFacts {
            in_flight_turns: 1,
            ..facts()
        },
        LifecycleFacts {
            queued_or_running_operations: 1,
            ..facts()
        },
    ] {
        let error = service
            .plan(&mut blocked, LifecycleAction::Uninstall)
            .unwrap_err();
        assert_eq!(
            error,
            LifecycleBlockReason::Busy("此Agent还有正在执行的进程，暂时无法卸载/移除".to_string())
        );
    }

    let mut uninstallable = facts();
    let plan = service
        .plan(&mut uninstallable, LifecycleAction::Uninstall)
        .unwrap();
    assert_eq!(plan.delete_component_ids, ["managed"]);
    assert!(!plan.remove_membership);

    let mut removable = facts();
    let plan = service
        .plan(&mut removable, LifecycleAction::Remove)
        .unwrap();
    assert_eq!(plan.delete_component_ids, ["managed"]);
    assert!(plan.remove_membership);

    let mut built_in = LifecycleFacts {
        built_in: true,
        ..facts()
    };
    assert!(matches!(
        service.plan(&mut built_in, LifecycleAction::Remove),
        Err(LifecycleBlockReason::BuiltInCannotBeRemoved)
    ));
}
