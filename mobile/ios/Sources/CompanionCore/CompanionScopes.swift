/// Companion Device scopes from ADR-0054. Authorization still checks each
/// scope; this set is only the pairing allowlist the phone will accept.
public enum CompanionScopes {
    public static let allowed: Set<String> = [
        "conversation.read",
        "conversation.write",
        "conversation.attach",
        "conversation.permission",
        "conversation.question",
        "conversation.cancel",
        "conversation.steer",
        "artifact.read",
        "workflow.read",
        "automation.read",
        "delegation.read",
        "notification.summary",
        "offline.read",
    ]

    public static func extras(_ scopes: [String]) -> Set<String> {
        Set(scopes).subtracting(allowed)
    }
}
