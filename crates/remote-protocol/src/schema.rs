use std::{fs, io, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    CommandRequest, CommandResponse, CreatePairingRequest, DeviceCredential, ErrorEnvelope,
    OfflineConversationCache, PairingChallenge, RedeemPairingRequest, RevokeDeviceResponse,
    ServerCapabilities, SubscriptionClientMessage, SubscriptionServerMessage,
    TerminalNotificationSummary,
};

const JSON_SCHEMA_ID: &str = "https://schemas.vibex.dev/remote-protocol/v1/schema.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProtocolSchemaBundle {
    pub protocol_version: String,
    pub json_schema: Value,
    pub openapi: Value,
}

#[allow(dead_code)]
#[derive(JsonSchema)]
struct RemoteProtocolDocument {
    capabilities: ServerCapabilities,
    command_request: CommandRequest<Value>,
    command_response: CommandResponse<Value>,
    command_error: ErrorEnvelope,
    subscription_client_message: SubscriptionClientMessage,
    subscription_server_message: SubscriptionServerMessage,
    create_pairing_request: CreatePairingRequest,
    pairing_challenge: PairingChallenge,
    redeem_pairing_request: RedeemPairingRequest,
    device_credential: DeviceCredential,
    revoke_device_response: RevokeDeviceResponse,
    terminal_notification_summary: TerminalNotificationSummary,
    offline_conversation_cache: OfflineConversationCache,
}

pub fn protocol_schema_bundle() -> ProtocolSchemaBundle {
    let mut json_schema =
        serde_json::to_value(schemars::schema_for!(RemoteProtocolDocument)).expect("JSON schema");
    let root = json_schema
        .as_object_mut()
        .expect("schema root must be an object");
    root.insert("$id".to_owned(), Value::String(JSON_SCHEMA_ID.to_owned()));
    root.insert(
        "title".to_owned(),
        Value::String("VibeX Remote Protocol v1".to_owned()),
    );
    if let Some(read_only) = root
        .get_mut("$defs")
        .and_then(Value::as_object_mut)
        .and_then(|definitions| definitions.get_mut("OfflineConversationCache"))
        .and_then(Value::as_object_mut)
        .and_then(|schema| schema.get_mut("properties"))
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut("read_only"))
        .and_then(Value::as_object_mut)
    {
        read_only.insert("const".to_owned(), Value::Bool(true));
    }

    ProtocolSchemaBundle {
        protocol_version: crate::PROTOCOL_VERSION.to_owned(),
        openapi: openapi_document(&json_schema),
        json_schema,
    }
}

pub fn write_protocol_schema_artifacts(output: impl AsRef<Path>) -> io::Result<()> {
    let output = output.as_ref();
    fs::create_dir_all(output)?;
    let bundle = protocol_schema_bundle();
    write_pretty_json(&output.join("schema.json"), &bundle.json_schema)?;
    write_pretty_json(&output.join("openapi.json"), &bundle.openapi)
}

fn write_pretty_json(path: &Path, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    fs::write(path, bytes)
}

fn openapi_document(json_schema: &Value) -> Value {
    let mut definitions = json_schema
        .get("$defs")
        .cloned()
        .unwrap_or_else(|| json!({}));
    rewrite_schema_references(&mut definitions);
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "VibeX Remote Protocol",
            "version": crate::PROTOCOL_VERSION,
        },
        "servers": [{"url": "/api/v1"}],
        "paths": {
            "/capabilities": {
                "get": {
                    "operationId": "getCapabilities",
                    "security": [{"bearerAuth": []}],
                    "responses": {
                        "200": {
                            "description": "Negotiated Server capabilities",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ServerCapabilities"}
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/auth/pairings": {
                "post": {
                    "operationId": "createDevicePairing",
                    "security": [{"bearerAuth": []}],
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/CreatePairingRequest"}
                            }
                        }
                    },
                    "responses": {
                        "201": {
                            "description": "Short-lived one-time pairing challenge",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/PairingChallenge"}
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/auth/pairings/redeem": {
                "post": {
                    "operationId": "redeemDevicePairing",
                    "security": [],
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/RedeemPairingRequest"}
                            }
                        }
                    },
                    "responses": {
                        "201": {
                            "description": "Device credential returned exactly once",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/DeviceCredential"}
                                }
                            }
                        },
                        "409": {
                            "description": "Pairing expired or already redeemed",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ErrorEnvelope"}
                                }
                            }
                        }
                    }
                }
            },
            "/auth/devices/{device_id}": {
                "delete": {
                    "operationId": "revokeDevice",
                    "security": [{"bearerAuth": []}],
                    "parameters": [{
                        "name": "device_id",
                        "in": "path",
                        "required": true,
                        "schema": {"type": "string", "format": "uuid"}
                    }],
                    "responses": {
                        "200": {
                            "description": "Device credential revoked",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/RevokeDeviceResponse"}
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/call/{command}": {
                "post": {
                    "operationId": "callApplicationCommand",
                    "security": [{"bearerAuth": []}],
                    "parameters": [{
                        "name": "command",
                        "in": "path",
                        "required": true,
                        "schema": {"type": "string"}
                    }],
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/CommandRequest"}
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Application command result",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/CommandResponse"}
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/conversations/{conversation_id}/offline": {
                "get": {
                    "operationId": "readOfflineConversation",
                    "security": [{"bearerAuth": []}],
                    "parameters": [
                        {
                            "name": "conversation_id",
                            "in": "path",
                            "required": true,
                            "schema": {"type": "string", "format": "uuid"}
                        },
                        {
                            "name": "after_sequence",
                            "in": "query",
                            "required": false,
                            "schema": {"type": "integer", "format": "int64", "minimum": 0}
                        }
                    ],
                    "responses": {
                        "200": {
                            "description": "Durable read-only event cache",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "$ref": "#/components/schemas/OfflineConversationCache"
                                    }
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/conversations/{conversation_id}/notification-summary": {
                "get": {
                    "operationId": "getTerminalNotificationSummary",
                    "security": [{"bearerAuth": []}],
                    "parameters": [{
                        "name": "conversation_id",
                        "in": "path",
                        "required": true,
                        "schema": {"type": "string", "format": "uuid"}
                    }],
                    "responses": {
                        "200": {
                            "description": "Secret-free terminal outcome summary",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "$ref": "#/components/schemas/TerminalNotificationSummary"
                                    }
                                }
                            }
                        },
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            },
            "/ws": {
                "get": {
                    "operationId": "openSubscriptionSocket",
                    "security": [{"webSocketToken": []}],
                    "responses": {
                        "101": {"description": "WebSocket subscription stream"},
                        "401": {"$ref": "#/components/responses/Unauthorized"}
                    }
                }
            }
        },
        "components": {
            "schemas": definitions,
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer"},
                "webSocketToken": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "Sec-WebSocket-Protocol"
                }
            },
            "responses": {
                "Unauthorized": {
                    "description": "Missing, expired, or revoked credential",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorEnvelope"}
                        }
                    }
                }
            }
        }
    })
}

fn rewrite_schema_references(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                rewrite_schema_references(value);
            }
        }
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref")
                && let Some(name) = reference.strip_prefix("#/$defs/")
            {
                *reference = format!("#/components/schemas/{name}");
            }
            for value in object.values_mut() {
                rewrite_schema_references(value);
            }
        }
        _ => {}
    }
}
