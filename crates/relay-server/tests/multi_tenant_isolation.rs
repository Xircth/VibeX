use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{
        WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::{SinkExt, StreamExt};
use relay_server::{ControlClientFrame, ControlServerFrame, RelayServerState, run_relay_server};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

async fn spawn_mock_desktop_host(host_id: &str, host_name: &str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock host");
    let port = listener.local_addr().unwrap().port();
    let id = host_id.to_string();
    let name = host_name.to_string();

    let app = Router::new()
        .route(
            "/health",
            get({
                let id = id.clone();
                let name = name.clone();
                move || {
                    let id = id.clone();
                    let name = name.clone();
                    async move {
                        Json(json!({
                            "status": "ok",
                            "host_id": id,
                            "name": name,
                        }))
                    }
                }
            }),
        )
        .route(
            "/api/v1/echo",
            post({
                let id = id.clone();
                move |Json(payload): Json<Value>| {
                    let id = id.clone();
                    async move {
                        Json(json!({
                            "served_by_host_id": id,
                            "echo": payload,
                        }))
                    }
                }
            }),
        )
        .route(
            "/api/v1/ws",
            get(move |ws: WebSocketUpgrade| {
                let id = id.clone();
                async move {
                    ws.protocols(["vibex.v1"])
                        .on_upgrade(move |socket| handle_mock_ws(socket, id))
                }
            }),
        )
        .with_state(());

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    port
}

async fn handle_mock_ws(mut socket: WebSocket, host_id: String) {
    while let Some(Ok(Message::Text(text))) = socket.next().await {
        let reply = json!({
            "type": "pong",
            "host_id": host_id,
            "received": text.to_string(),
        })
        .to_string();
        if socket.send(Message::Text(reply.into())).await.is_err() {
            break;
        }
    }
}

async fn spawn_host_relay_agent(
    relay_addr: std::net::SocketAddr,
    host_id: String,
    token: String,
    host_name: String,
    local_port: u16,
) {
    let stream = TcpStream::connect(relay_addr).await.expect("connect relay");
    let _ = stream.set_nodelay(true);
    let (reader, mut writer) = stream.into_split();
    let name_b64 = BASE64.encode(host_name.as_bytes());
    let lan_b64 = BASE64
        .encode(serde_json::to_vec(&vec![format!("http://192.168.1.10:{local_port}")]).unwrap());
    writer
        .write_all(format!("VIBEX-CTRL v2 {host_id} {token} {name_b64} {lan_b64}\n").as_bytes())
        .await
        .expect("send ctrl hello");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.starts_with("OK ") || trimmed.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<ControlServerFrame>(trimmed) else {
                continue;
            };
            match frame {
                ControlServerFrame::Ping { ts } => {
                    let pong = serde_json::to_string(&ControlClientFrame::Pong { ts }).unwrap();
                    let _ = tx.send(format!("{pong}\n"));
                }
                ControlServerFrame::ReplenishPool { count } => {
                    for _ in 0..count {
                        let host_id = host_id.clone();
                        let token = token.clone();
                        tokio::spawn(async move {
                            let Ok(data_stream) = TcpStream::connect(relay_addr).await else {
                                return;
                            };
                            let _ = data_stream.set_nodelay(true);
                            let mut buf_stream = BufReader::new(data_stream);
                            if buf_stream
                                .get_mut()
                                .write_all(
                                    format!("VIBEX-DATA v2 {host_id} {token} POOL\n").as_bytes(),
                                )
                                .await
                                .is_err()
                            {
                                return;
                            }
                            let mut cmd_line = String::new();
                            loop {
                                cmd_line.clear();
                                let Ok(n) = buf_stream.read_line(&mut cmd_line).await else {
                                    return;
                                };
                                if n == 0 {
                                    return;
                                }
                                let cmd = cmd_line.trim();
                                if cmd == "NOOP" {
                                    continue;
                                }
                                if let Some(target_host_id) = cmd.strip_prefix("USE ") {
                                    if target_host_id.trim() != host_id {
                                        return;
                                    }
                                    break;
                                }
                            }
                            let Ok(mut local) = TcpStream::connect(("127.0.0.1", local_port)).await
                            else {
                                return;
                            };
                            let _ = local.set_nodelay(true);
                            let buffered = buf_stream.buffer().to_vec();
                            let mut remote = buf_stream.into_inner();
                            if !buffered.is_empty() && local.write_all(&buffered).await.is_err() {
                                return;
                            }
                            let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                        });
                    }
                }
                ControlServerFrame::OpenData {
                    host_id: target_host_id,
                    conn_id,
                } => {
                    if target_host_id != host_id {
                        continue;
                    }
                    let host_id = host_id.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        let Ok(mut remote) = TcpStream::connect(relay_addr).await else {
                            return;
                        };
                        let _ = remote.set_nodelay(true);
                        if remote
                            .write_all(
                                format!("VIBEX-DATA v2 {host_id} {token} {conn_id}\n").as_bytes(),
                            )
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let Ok(mut local) = TcpStream::connect(("127.0.0.1", local_port)).await
                        else {
                            return;
                        };
                        let _ = local.set_nodelay(true);
                        let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                    });
                }
                ControlServerFrame::HttpReq {
                    host_id: req_host_id,
                    id,
                    method,
                    path,
                    headers,
                    body_b64,
                } => {
                    if req_host_id != host_id {
                        continue;
                    }
                    let client = client.clone();
                    let tx = tx.clone();
                    let host_id = host_id.clone();
                    tokio::spawn(async move {
                        let url = format!("http://127.0.0.1:{local_port}{path}");
                        let m = reqwest::Method::from_bytes(method.as_bytes())
                            .unwrap_or(reqwest::Method::GET);
                        let mut req = client.request(m, &url);
                        for (k, v) in headers {
                            req = req.header(&k, &v);
                        }
                        let body = BASE64.decode(body_b64).unwrap_or_default();
                        if !body.is_empty() {
                            req = req.body(body);
                        }
                        if let Ok(resp) = req.send().await {
                            let status = resp.status().as_u16();
                            let mut out_headers = Vec::new();
                            for (k, v) in resp.headers() {
                                if let Ok(s) = v.to_str() {
                                    out_headers.push((k.as_str().to_string(), s.to_string()));
                                }
                            }
                            let resp_bytes = resp.bytes().await.unwrap_or_default();
                            let frame = serde_json::to_string(&ControlClientFrame::HttpRes {
                                host_id,
                                id,
                                status,
                                headers: out_headers,
                                body_b64: BASE64.encode(&resp_bytes),
                            })
                            .unwrap();
                            let _ = tx.send(format!("{frame}\n"));
                        }
                    });
                }
            }
        }
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multi_tenant_http_keepalive_and_websocket_strictly_isolated() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let relay_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind relay");
    let relay_addr = relay_listener.local_addr().unwrap();
    let state = Arc::new(RelayServerState::default());
    let state_clone = state.clone();
    tokio::spawn(async move {
        let _ = run_relay_server(relay_listener, state_clone).await;
    });

    let port_alpha = spawn_mock_desktop_host("host-alpha", "MacBook Alpha").await;
    let port_beta = spawn_mock_desktop_host("host-beta", "Workstation Beta").await;

    spawn_host_relay_agent(
        relay_addr,
        "host-alpha".to_string(),
        "token_alpha_secret_123456".to_string(),
        "MacBook Alpha".to_string(),
        port_alpha,
    )
    .await;

    spawn_host_relay_agent(
        relay_addr,
        "host-beta".to_string(),
        "token_beta_secret_654321".to_string(),
        "Workstation Beta".to_string(),
        port_beta,
    )
    .await;

    tokio::time::sleep(Duration::from_millis(80)).await;

    // 1. Verify token hijacking attempt against host-alpha is rejected
    {
        let mut attacker = TcpStream::connect(relay_addr).await.unwrap();
        attacker
            .write_all(b"VIBEX-CTRL v2 host-alpha wrong_attacker_token_999999\n")
            .await
            .unwrap();
        let mut reader = BufReader::new(attacker);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(line.starts_with("ERR unauthorized_host_token"));
    }

    // 2. Fire 30 concurrent interleaved HTTP requests over a single Keep-Alive client pool
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(8)
        .build()
        .unwrap();

    let mut handles = Vec::new();
    for i in 0..30 {
        let client = client.clone();
        let target_host = if i % 2 == 0 {
            "host-alpha"
        } else {
            "host-beta"
        };
        handles.push(tokio::spawn(async move {
            let url = format!("http://{relay_addr}/t/{target_host}/api/v1/echo");
            let resp = client
                .post(&url)
                .json(&json!({ "seq": i, "expected": target_host }))
                .send()
                .await
                .expect("http echo");
            assert_eq!(resp.status(), 200);
            let routed_header = resp
                .headers()
                .get("x-vibex-routed-host-id")
                .unwrap()
                .to_str()
                .unwrap()
                .to_string();
            assert_eq!(routed_header, target_host);
            let body: Value = resp.json().await.unwrap();
            assert_eq!(body["served_by_host_id"], target_host);
            assert_eq!(body["echo"]["seq"], i);
            assert_eq!(body["echo"]["expected"], target_host);
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    // 3. Verify same-net and shared cloud discovery never leak online hosts across tenants
    let disc: Value = client
        .get(format!("http://{relay_addr}/v1/discover/same-net"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let hosts = disc["hosts"].as_array().unwrap();
    assert_eq!(hosts.len(), 0);

    let shared_beacon_post = client
        .post(format!("http://{relay_addr}/v1/beacon/vbx-cloud-hosts-v1"))
        .body(r#"{"host_id":"host-alpha"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(shared_beacon_post.status(), 403);

    // 4. Verify concurrent WebSockets to host-alpha and host-beta never cross messages
    let ws_url_alpha = format!("ws://{relay_addr}/t/host-alpha/api/v1/ws");
    let ws_url_beta = format!("ws://{relay_addr}/t/host-beta/api/v1/ws");

    let (mut ws_alpha, _) = tokio_tungstenite::connect_async(&ws_url_alpha)
        .await
        .expect("connect ws alpha");
    let (mut ws_beta, _) = tokio_tungstenite::connect_async(&ws_url_beta)
        .await
        .expect("connect ws beta");

    ws_alpha
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "hello-alpha".into(),
        ))
        .await
        .unwrap();
    ws_beta
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "hello-beta".into(),
        ))
        .await
        .unwrap();

    let msg_a = ws_alpha.next().await.unwrap().unwrap().into_text().unwrap();
    let msg_b = ws_beta.next().await.unwrap().unwrap().into_text().unwrap();

    let json_a: Value = serde_json::from_str(&msg_a).unwrap();
    let json_b: Value = serde_json::from_str(&msg_b).unwrap();

    assert_eq!(json_a["host_id"], "host-alpha");
    assert_eq!(json_a["received"], "hello-alpha");
    assert_eq!(json_b["host_id"], "host-beta");
    assert_eq!(json_b["received"], "hello-beta");
}
