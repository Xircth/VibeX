//! Deterministic stdio ACP process used by management/runtime integration tests.
//!
//! It intentionally exposes no product behavior. Tests can launch this exact
//! executable to exercise a real process boundary without depending on an
//! installed third-party Agent or the network.

use agent_client_protocol::{
    Agent, Stdio,
    schema::v1::{AgentCapabilities, Implementation, InitializeRequest, InitializeResponse},
};

#[tokio::main]
async fn main() -> agent_client_protocol::Result<()> {
    Agent
        .builder()
        .name("vibex-management-fixture")
        .on_receive_request(
            async move |initialize: InitializeRequest, responder, _connection| {
                responder.respond(
                    InitializeResponse::new(initialize.protocol_version)
                        .agent_capabilities(AgentCapabilities::new())
                        .agent_info(Implementation::new(
                            "vibex-management-fixture",
                            "1.0.0-test",
                        )),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}
