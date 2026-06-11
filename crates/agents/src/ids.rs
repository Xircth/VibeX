use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        #[ts(export)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }
    };
}

id_type!(AgentConnectionId);
id_type!(AgentSessionId);
id_type!(AgentPromptId);
id_type!(AgentPermissionId);
id_type!(AgentTerminalId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_distinct_and_serializable() {
        let connection = AgentConnectionId::new();
        let session = AgentSessionId::new();

        assert_ne!(connection.to_string(), session.to_string());
        let encoded = serde_json::to_string(&connection).unwrap();
        let decoded: AgentConnectionId = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, connection);
    }
}
