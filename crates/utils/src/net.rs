//! Portable LAN interface discovery for Host reachability.

use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInterfaceAddress {
    pub name: String,
    pub ip: String,
    pub family: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdvertisedListenAddress {
    pub origin: String,
    pub interface: String,
    pub ip: String,
    pub family: String,
}

pub fn is_advertisable_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    let is_benchmarking = a == 198 && (b == 18 || b == 19);
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && !is_benchmarking
}

pub fn is_advertisable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_advertisable_ipv4(ip),
        IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unicast_link_local()
                && ip.to_ipv4_mapped().is_none()
        }
    }
}

/// Returns true when `ip` belongs to Tailscale's CGNAT range (`100.64.0.0/10`)
/// or Tailscale's ULA prefix (`fd7a:115c:a1e0::/48`).
pub fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            a == 100 && (64..=127).contains(&b)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
        }
    }
}

fn is_virtual_tunnel_interface_name(interface_name: &str) -> bool {
    let lower = interface_name.trim().to_ascii_lowercase();
    const BLACKLIST_PREFIXES: &[&str] = &[
        "utun", "tun", "tap", "veth", "docker", "br-", "vmnet", "vboxnet", "virbr", "wg", "mihomo",
        "clash", "surge", "singbox",
    ];
    BLACKLIST_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Checks whether a local `(interface_name, ip)` pair is eligible as a WebRTC
/// Host Candidate or physical LAN reachability address (filtering proxy TUN
/// adapters and Fake-IP ranges while preserving Tailscale).
pub fn is_webrtc_host_candidate_eligible(interface_name: &str, ip: IpAddr) -> bool {
    if !is_advertisable_ip(ip) {
        return false;
    }
    if is_tailscale_ip(ip) {
        return true;
    }
    !is_virtual_tunnel_interface_name(interface_name)
}

/// Bind a UDP socket (used for STUN / TURN / WebRTC transport) directly to a
/// named physical network interface (`IP_BOUND_IF` on macOS, `SO_BINDTODEVICE`
/// on Linux) so proxy TUN default routes cannot hijack the socket.
pub fn bind_udp_socket_to_interface(
    socket: &UdpSocket,
    interface_name: &str,
) -> std::io::Result<()> {
    let trimmed = interface_name.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "interface name must be non-empty and not contain NUL",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::fd::AsRawFd};

        let c_name = CString::new(trimmed).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid interface name")
        })?;
        let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
        if index == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("network interface '{trimmed}' not found"),
            ));
        }
        let raw_fd = socket.as_raw_fd();
        let rc = unsafe {
            libc::setsockopt(
                raw_fd,
                libc::IPPROTO_IP,
                libc::IP_BOUND_IF,
                (&raw const index).cast::<libc::c_void>(),
                std::mem::size_of::<libc::c_uint>() as libc::socklen_t,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::fd::AsRawFd};

        let c_name = CString::new(trimmed).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid interface name")
        })?;
        let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
        if index == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("network interface '{trimmed}' not found"),
            ));
        }
        let bytes = c_name.as_bytes_with_nul();
        let rc = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_BINDTODEVICE,
                bytes.as_ptr().cast::<libc::c_void>(),
                bytes.len() as libc::socklen_t,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let exists = host_interface_addresses()
            .iter()
            .any(|addr| addr.name.eq_ignore_ascii_case(trimmed));
        let _ = socket;
        if !exists {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("network interface '{trimmed}' not found"),
            ));
        }
        Ok(())
    }
}

/// Returns the OS name of the primary active physical IPv4 network interface
/// (e.g. `"en0"` on macOS or `"eth0"` / `"wlan0"` on Linux), excluding loopback,
/// proxy TUN adapters (`utun*`, `tun*`), and Tailscale interfaces.
pub fn primary_physical_interface_name() -> Option<String> {
    host_interface_addresses()
        .into_iter()
        .find(|addr| {
            addr.family == "ipv4"
                && !addr.name.trim().is_empty()
                && !is_virtual_tunnel_interface_name(&addr.name)
                && addr
                    .ip
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| is_advertisable_ip(ip) && !is_tailscale_ip(ip))
        })
        .map(|addr| addr.name)
}

/// Bind a `tokio::net::TcpSocket` directly to a named physical network interface
/// (`IP_BOUND_IF` on macOS, `SO_BINDTODEVICE` on Linux) so proxy TUN routes
/// cannot hijack domestic relay connections.
pub fn bind_tcp_socket_to_interface(
    socket: &tokio::net::TcpSocket,
    interface_name: &str,
) -> std::io::Result<()> {
    let trimmed = interface_name.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "interface name must be non-empty and not contain NUL",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::fd::AsRawFd};

        let c_name = CString::new(trimmed).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid interface name")
        })?;
        let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
        if index == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("network interface '{trimmed}' not found"),
            ));
        }
        let rc = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::IPPROTO_IP,
                libc::IP_BOUND_IF,
                (&raw const index).cast::<libc::c_void>(),
                std::mem::size_of::<libc::c_uint>() as libc::socklen_t,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::{ffi::CString, os::fd::AsRawFd};

        let c_name = CString::new(trimmed).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid interface name")
        })?;
        let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
        if index == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("network interface '{trimmed}' not found"),
            ));
        }
        let bytes = c_name.as_bytes_with_nul();
        let rc = unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_BINDTODEVICE,
                bytes.as_ptr().cast::<libc::c_void>(),
                bytes.len() as libc::socklen_t,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = socket;
        let _ = trimmed;
        Ok(())
    }
}

/// Connect a TCP stream to `addr` with `TCP_NODELAY = true`, preferring the
/// primary physical network interface (`IP_BOUND_IF` / `SO_BINDTODEVICE`) for
/// non-loopback IPv4 targets so Clash/Mihomo TUN routes are bypassed.
pub async fn connect_tcp_bypassing_tun(addr: SocketAddr) -> std::io::Result<tokio::net::TcpStream> {
    if let SocketAddr::V4(v4_addr) = addr
        && !v4_addr.ip().is_loopback()
        && let Some(iface) = primary_physical_interface_name()
        && let Ok(socket) = tokio::net::TcpSocket::new_v4()
    {
        let _ = socket.set_nodelay(true);
        if bind_tcp_socket_to_interface(&socket, &iface).is_ok()
            && let Ok(Ok(stream)) =
                tokio::time::timeout(std::time::Duration::from_secs(4), socket.connect(addr)).await
        {
            let _ = stream.set_nodelay(true);
            return Ok(stream);
        }
    }

    let stream = tokio::net::TcpStream::connect(addr).await?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

static DIRECT_DNS_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (Ipv4Addr, std::time::Instant)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Resolve `host:port` to a real IPv4 `SocketAddr`, bypassing Clash Fake-IP DNS
/// (`198.18.0.0/15`) by querying `223.5.5.5:53` / `119.29.29.29:53` over the
/// physical interface when `host` is a domain name, with a 5-minute TTL cache.
pub fn resolve_host_ipv4_direct(host: &str, port: u16) -> Option<SocketAddr> {
    let trimmed = host.trim().trim_matches(|ch| ch == '[' || ch == ']');
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.eq_ignore_ascii_case("localhost") {
        return Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Some(SocketAddr::new(ip, port));
    }

    let cache_key = trimmed.to_ascii_lowercase();
    if let Ok(guard) = DIRECT_DNS_CACHE.lock()
        && let Some((cached_ip, ts)) = guard.get(&cache_key)
        && ts.elapsed() < std::time::Duration::from_secs(300)
    {
        return Some(SocketAddr::new(IpAddr::V4(*cached_ip), port));
    }

    // 1. Try direct UDP or TCP DNS A-record query to 223.5.5.5:53 / 119.29.29.29:53 bound to physical interface
    if let Some(ip) = query_dns_a_record_direct(trimmed, Ipv4Addr::new(223, 5, 5, 5))
        .or_else(|| query_dns_a_record_direct(trimmed, Ipv4Addr::new(119, 29, 29, 29)))
        .or_else(|| query_dns_a_record_tcp_direct(trimmed, Ipv4Addr::new(223, 5, 5, 5)))
        .or_else(|| query_dns_a_record_tcp_direct(trimmed, Ipv4Addr::new(119, 29, 29, 29)))
    {
        if let Ok(mut guard) = DIRECT_DNS_CACHE.lock() {
            guard.insert(cache_key, (ip, std::time::Instant::now()));
        }
        return Some(SocketAddr::new(IpAddr::V4(ip), port));
    }

    // 2. Fallback to system resolver, rejecting Fake-IP (198.18.0.0/15)
    let resolved = (trimmed, port)
        .to_socket_addrs()
        .ok()?
        .find(|addr| match addr.ip() {
            IpAddr::V4(v4) => {
                let [a, b, _, _] = v4.octets();
                !(a == 198 && (b == 18 || b == 19))
            }
            IpAddr::V6(_) => true,
        })?;
    if let IpAddr::V4(v4) = resolved.ip()
        && let Ok(mut guard) = DIRECT_DNS_CACHE.lock()
    {
        guard.insert(cache_key, (v4, std::time::Instant::now()));
    }
    Some(resolved)
}

fn build_dns_a_query_packet(domain: &str) -> Option<Vec<u8>> {
    let mut packet = Vec::with_capacity(64);
    packet.extend_from_slice(&[
        0x56, 0x58, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    for label in domain.split('.') {
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > 63 {
            return None;
        }
        packet.push(bytes.len() as u8);
        packet.extend_from_slice(bytes);
    }
    packet.push(0x00);
    packet.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    Some(packet)
}

fn parse_dns_a_response_packet(buf: &[u8]) -> Option<Ipv4Addr> {
    let n = buf.len();
    if n < 12 || buf[0] != 0x56 || buf[1] != 0x58 {
        return None;
    }
    let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    if ancount == 0 {
        return None;
    }

    let mut idx = 12;
    while idx < n && buf[idx] != 0 {
        let len = buf[idx] as usize;
        idx += 1 + len;
    }
    idx += 5;

    for _ in 0..ancount {
        if idx + 10 > n {
            break;
        }
        if buf[idx] & 0xC0 == 0xC0 {
            idx += 2;
        } else {
            while idx < n && buf[idx] != 0 {
                idx += 1 + (buf[idx] as usize);
            }
            idx += 1;
        }
        if idx + 10 > n {
            break;
        }
        let rtype = u16::from_be_bytes([buf[idx], buf[idx + 1]]);
        let rdlen = u16::from_be_bytes([buf[idx + 8], buf[idx + 9]]) as usize;
        idx += 10;
        if idx + rdlen > n {
            break;
        }
        if rtype == 1 && rdlen == 4 {
            let ip = Ipv4Addr::new(buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]);
            let [a, b, _, _] = ip.octets();
            if !(a == 198 && (b == 18 || b == 19)) && !ip.is_unspecified() {
                return Some(ip);
            }
        }
        idx += rdlen;
    }
    None
}

fn query_dns_a_record_direct(domain: &str, dns_server: Ipv4Addr) -> Option<Ipv4Addr> {
    use std::time::Duration;

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    if let Some(iface) = primary_physical_interface_name() {
        let _ = bind_udp_socket_to_interface(&socket, &iface);
    }
    let _ = socket.set_read_timeout(Some(Duration::from_millis(1200)));
    let _ = socket.set_write_timeout(Some(Duration::from_millis(1200)));

    let packet = build_dns_a_query_packet(domain)?;
    socket
        .send_to(&packet, SocketAddr::new(IpAddr::V4(dns_server), 53))
        .ok()?;
    let mut buf = [0u8; 512];
    let (n, _) = socket.recv_from(&mut buf).ok()?;
    parse_dns_a_response_packet(&buf[..n])
}

fn query_dns_a_record_tcp_direct(domain: &str, dns_server: Ipv4Addr) -> Option<Ipv4Addr> {
    use std::{
        io::{Read, Write},
        time::Duration,
    };

    let packet = build_dns_a_query_packet(domain)?;
    let target = SocketAddr::new(IpAddr::V4(dns_server), 53);
    let mut stream = TcpStream::connect_timeout(&target, Duration::from_millis(1500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let len_prefix = (packet.len() as u16).to_be_bytes();
    stream.write_all(&len_prefix).ok()?;
    stream.write_all(&packet).ok()?;
    let mut resp_len_bytes = [0u8; 2];
    stream.read_exact(&mut resp_len_bytes).ok()?;
    let resp_len = u16::from_be_bytes(resp_len_bytes) as usize;
    if !(12..=2048).contains(&resp_len) {
        return None;
    }
    let mut buf = vec![0u8; resp_len];
    stream.read_exact(&mut buf).ok()?;
    parse_dns_a_response_packet(&buf)
}

pub fn http_origin(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(ip) => format!("http://{ip}:{port}"),
        IpAddr::V6(ip) => format!("http://[{ip}]:{port}"),
    }
}

/// IPv4 addresses that a Host may advertise as LAN reachability.
///
/// Combines a UDP route probe with OS interface enumeration so offline or
/// multi-homed machines still surface every usable LAN address.
pub fn lan_ipv4_addrs() -> Vec<Ipv4Addr> {
    host_interface_addresses()
        .into_iter()
        .filter_map(|address| address.ip.parse::<Ipv4Addr>().ok())
        .filter(|ip| is_advertisable_ipv4(*ip))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Named unicast addresses on up, non-loopback interfaces.
pub fn host_interface_addresses() -> Vec<HostInterfaceAddress> {
    let enumerated = interface_addrs();
    let mut seen = BTreeSet::new();
    let mut addresses = Vec::new();
    let mut push = |address: HostInterfaceAddress| {
        if seen.insert(address.ip.clone()) {
            addresses.push(address);
        }
    };

    if let Some(ip) = default_route_ipv4() {
        if let Some(address) = enumerated
            .iter()
            .find(|address| address.ip == ip.to_string())
        {
            if is_webrtc_host_candidate_eligible(&address.name, IpAddr::V4(ip)) {
                push(address.clone());
            }
        } else if is_webrtc_host_candidate_eligible("", IpAddr::V4(ip)) {
            push(HostInterfaceAddress {
                name: String::new(),
                ip: ip.to_string(),
                family: "ipv4".to_string(),
            });
        }
    }

    for address in enumerated {
        if let Ok(ip) = address.ip.parse::<IpAddr>()
            && is_webrtc_host_candidate_eligible(&address.name, ip)
        {
            push(address);
        }
    }
    addresses
}

fn default_route_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(1, 1, 1, 1), 80)).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(addr) if is_advertisable_ipv4(*addr.ip()) => Some(*addr.ip()),
        _ => None,
    }
}

pub fn advertised_listen_addresses(port: u16, allow_lan: bool) -> Vec<AdvertisedListenAddress> {
    let mut addresses = vec![AdvertisedListenAddress {
        origin: format!("http://127.0.0.1:{port}"),
        interface: "loopback".to_string(),
        ip: "127.0.0.1".to_string(),
        family: "ipv4".to_string(),
    }];
    if !allow_lan {
        return addresses;
    }
    for address in host_interface_addresses() {
        let Ok(ip) = address.ip.parse::<IpAddr>() else {
            continue;
        };
        let origin = http_origin(ip, port);
        if addresses.iter().any(|item| item.origin == origin) {
            continue;
        }
        addresses.push(AdvertisedListenAddress {
            origin,
            interface: address.name,
            ip: address.ip,
            family: address.family,
        });
    }
    addresses
}

pub fn advertised_http_origins(port: u16, allow_lan: bool) -> Vec<String> {
    advertised_listen_addresses(port, allow_lan)
        .into_iter()
        .map(|address| address.origin)
        .collect()
}

pub fn listen_allows_lan(listen_addr: SocketAddr) -> bool {
    match listen_addr.ip() {
        IpAddr::V4(ip) => ip.is_unspecified() || is_advertisable_ipv4(ip),
        IpAddr::V6(ip) => ip.is_unspecified() || !(ip.is_loopback() || ip.is_multicast()),
    }
}

/// Best-effort public IPv4 as seen from the internet. Skipped when the
/// lookup fails or returns a private address.
pub fn public_ipv4() -> Option<Ipv4Addr> {
    use std::{
        io::{Read, Write},
        time::Duration,
    };

    let addr = "api.ipify.org:80"
        .to_socket_addrs()
        .ok()?
        .find(|candidate| candidate.is_ipv4())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    let text = body.split("\r\n\r\n").nth(1)?.trim();
    let ip = text.parse::<Ipv4Addr>().ok()?;
    (is_advertisable_ipv4(ip) && !ip.is_private()).then_some(ip)
}

/// Hosts that may use HTTP for a first-party LAN or loopback VibeX Host.
pub fn is_trusted_http_host(host: &str) -> bool {
    let host = host.trim().trim_matches(|ch| ch == '[' || ch == ']');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

/// Other addresses on each local IPv4 /24, excluding this machine's own IPs.
pub fn lan_probe_ipv4s() -> Vec<Ipv4Addr> {
    let own = lan_ipv4_addrs();
    let mut ips = BTreeSet::new();
    for ip in &own {
        let [a, b, c, d] = ip.octets();
        for host in 1..=254_u8 {
            if host == d {
                continue;
            }
            ips.insert(Ipv4Addr::new(a, b, c, host));
        }
    }
    ips.into_iter().collect()
}

pub fn local_hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let result = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if result != 0 {
            return None;
        }
        let end = buf.iter().position(|&byte| byte == 0).unwrap_or(buf.len());
        let name = std::str::from_utf8(&buf[..end]).ok()?.trim();
        (!name.is_empty()).then(|| name.to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME")
            .ok()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

#[cfg(unix)]
fn interface_addrs() -> Vec<HostInterfaceAddress> {
    use std::ffi::CStr;

    let mut addrs = Vec::new();
    let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut ifap) } != 0 || ifap.is_null() {
        return addrs;
    }
    let mut cursor = ifap;
    while !cursor.is_null() {
        let entry = unsafe { &*cursor };
        let flags = entry.ifa_flags;
        if flags & libc::IFF_LOOPBACK as u32 != 0 || flags & libc::IFF_UP as u32 == 0 {
            cursor = entry.ifa_next;
            continue;
        }
        let name = if entry.ifa_name.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(entry.ifa_name) }
                .to_string_lossy()
                .into_owned()
        };
        if !entry.ifa_addr.is_null() {
            let family = unsafe { (*entry.ifa_addr).sa_family as i32 };
            if family == libc::AF_INET {
                let sin = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
                let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                if is_advertisable_ipv4(ip) {
                    addrs.push(HostInterfaceAddress {
                        name: name.clone(),
                        ip: ip.to_string(),
                        family: "ipv4".to_string(),
                    });
                }
            } else if family == libc::AF_INET6 {
                let sin6 = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in6) };
                let ip = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                if is_advertisable_ip(IpAddr::V6(ip)) {
                    addrs.push(HostInterfaceAddress {
                        name,
                        ip: ip.to_string(),
                        family: "ipv6".to_string(),
                    });
                }
            }
        }
        cursor = entry.ifa_next;
    }
    unsafe { libc::freeifaddrs(ifap) };
    addrs
}

#[cfg(windows)]
fn interface_addrs() -> Vec<HostInterfaceAddress> {
    use windows_sys::Win32::{
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
                GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6},
    };

    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    unsafe {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 0_u32;
        let first = GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut size,
        );
        if first != ERROR_BUFFER_OVERFLOW || size == 0 {
            return Vec::new();
        }
        let mut buffer = vec![0_u8; size as usize];
        let status = GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        );
        if status != 0 {
            return Vec::new();
        }

        let mut addrs = Vec::new();
        let mut current = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !current.is_null() {
            let adapter = &*current;
            if adapter.OperStatus == IfOperStatusUp {
                let name = wide_ptr_to_string(adapter.FriendlyName);
                let mut unicast = adapter.FirstUnicastAddress;
                while !unicast.is_null() {
                    let address = &*unicast;
                    let sockaddr = address.Address.lpSockaddr;
                    if !sockaddr.is_null() {
                        if (*sockaddr).sa_family == AF_INET {
                            let sin = &*(sockaddr.cast::<SOCKADDR_IN>());
                            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                            if is_advertisable_ipv4(ip) {
                                addrs.push(HostInterfaceAddress {
                                    name: name.clone(),
                                    ip: ip.to_string(),
                                    family: "ipv4".to_string(),
                                });
                            }
                        } else if (*sockaddr).sa_family == AF_INET6 {
                            let sin6 = &*(sockaddr.cast::<SOCKADDR_IN6>());
                            let ip = Ipv6Addr::from(sin6.sin6_addr.u.Byte);
                            if is_advertisable_ip(IpAddr::V6(ip)) {
                                addrs.push(HostInterfaceAddress {
                                    name: name.clone(),
                                    ip: ip.to_string(),
                                    family: "ipv6".to_string(),
                                });
                            }
                        }
                    }
                    unicast = address.Next;
                }
            }
            current = adapter.Next;
        }
        addrs
    }
}

#[cfg(windows)]
fn wide_ptr_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

#[cfg(not(any(unix, windows)))]
fn interface_addrs() -> Vec<HostInterfaceAddress> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv6Addr};

    use super::{
        advertised_http_origins, advertised_listen_addresses, http_origin, is_advertisable_ip,
        is_advertisable_ipv4, is_trusted_http_host, lan_ipv4_addrs, lan_probe_ipv4s,
        listen_allows_lan,
    };

    #[test]
    fn loopback_is_never_advertisable() {
        assert!(!is_advertisable_ipv4(std::net::Ipv4Addr::LOCALHOST));
        assert!(!is_advertisable_ipv4(std::net::Ipv4Addr::UNSPECIFIED));
        assert!(!is_advertisable_ipv4(std::net::Ipv4Addr::new(
            169, 254, 1, 1
        )));
        assert!(is_advertisable_ipv4(std::net::Ipv4Addr::new(
            192, 168, 1, 10
        )));
    }

    #[test]
    fn advertised_origins_without_lan_are_loopback_only() {
        assert_eq!(
            advertised_http_origins(17891, false),
            vec!["http://127.0.0.1:17891".to_string()]
        );
    }

    #[test]
    fn advertised_lan_origins_keep_loopback_and_drop_it_from_extra_entries() {
        let addresses = advertised_http_origins(17891, true);
        assert!(
            addresses
                .iter()
                .any(|address| address == "http://127.0.0.1:17891")
        );
        for address in addresses.iter().skip(1) {
            assert!(
                !address.contains("127.0.0.1"),
                "LAN advertisement included loopback: {address}"
            );
        }
        let _ = lan_ipv4_addrs();
    }

    #[test]
    fn unspecified_listen_is_treated_as_lan() {
        assert!(listen_allows_lan("0.0.0.0:17891".parse().expect("listen")));
        assert!(!listen_allows_lan(
            "127.0.0.1:17891".parse().expect("listen")
        ));
        assert!(listen_allows_lan(
            "192.168.1.10:17891".parse().expect("listen")
        ));
    }

    #[test]
    fn trusted_http_hosts_are_loopback_lan_or_mdns() {
        assert!(is_trusted_http_host("127.0.0.1"));
        assert!(is_trusted_http_host("localhost"));
        assert!(is_trusted_http_host("192.168.1.20"));
        assert!(is_trusted_http_host("10.0.0.8"));
        assert!(is_trusted_http_host("studio.local"));
        assert!(!is_trusted_http_host("example.com"));
        assert!(!is_trusted_http_host("8.8.8.8"));
    }

    #[test]
    fn lan_probe_skips_this_machines_addresses() {
        let own = lan_ipv4_addrs();
        let probed = lan_probe_ipv4s();
        for ip in own {
            assert!(!probed.contains(&ip), "probe list included local IP {ip}");
        }
    }

    #[test]
    fn ipv6_origins_use_brackets_and_skip_link_local() {
        let unique_local = Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1);
        assert!(is_advertisable_ip(IpAddr::V6(unique_local)));
        assert_eq!(
            http_origin(IpAddr::V6(unique_local), 17891),
            "http://[fd7a:115c:a1e0::1]:17891"
        );
        assert!(!is_advertisable_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_advertisable_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn advertised_listen_addresses_include_interface_names_when_lan_is_on() {
        let addresses = advertised_listen_addresses(17891, true);
        assert_eq!(addresses[0].origin, "http://127.0.0.1:17891");
        assert_eq!(addresses[0].interface, "loopback");
        for address in addresses.iter().skip(1) {
            assert!(!address.origin.contains("127.0.0.1"));
            assert!(
                address.family == "ipv4" || address.family == "ipv6",
                "unexpected family {}",
                address.family
            );
        }
    }

    #[test]
    fn webrtc_candidate_filter_rejects_proxy_tun_and_fake_ip_but_keeps_tailscale_and_physical_lan()
    {
        use std::net::Ipv4Addr;

        use super::{is_tailscale_ip, is_webrtc_host_candidate_eligible};

        // Physical Wi-Fi / Ethernet LAN
        assert!(is_webrtc_host_candidate_eligible(
            "en0",
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))
        ));
        assert!(is_webrtc_host_candidate_eligible(
            "eth0",
            IpAddr::V4(Ipv4Addr::new(10, 0, 1, 15))
        ));

        // Clash / Surge / Mihomo Fake-IP benchmark range 198.18.0.0/15 on any interface
        assert!(!is_webrtc_host_candidate_eligible(
            "en0",
            IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))
        ));
        assert!(!is_webrtc_host_candidate_eligible(
            "utun3",
            IpAddr::V4(Ipv4Addr::new(198, 19, 255, 254))
        ));

        // Non-Tailscale proxy TUN / container / virtual interfaces using private subnets
        assert!(!is_webrtc_host_candidate_eligible(
            "utun4",
            IpAddr::V4(Ipv4Addr::new(172, 19, 0, 1))
        ));
        assert!(!is_webrtc_host_candidate_eligible(
            "tun0",
            IpAddr::V4(Ipv4Addr::new(10, 8, 0, 2))
        ));
        assert!(!is_webrtc_host_candidate_eligible(
            "tap0",
            IpAddr::V4(Ipv4Addr::new(10, 9, 0, 2))
        ));
        assert!(!is_webrtc_host_candidate_eligible(
            "docker0",
            IpAddr::V4(Ipv4Addr::new(172, 17, 0, 1))
        ));
        assert!(!is_webrtc_host_candidate_eligible(
            "veth1a2b3c",
            IpAddr::V4(Ipv4Addr::new(172, 18, 0, 2))
        ));

        // Tailscale CGNAT (100.64.0.0/10) and Tailscale ULA (fd7a:115c:a1e0::/48) on utun / tailscale0 are allowed
        let ts_v4 = IpAddr::V4(Ipv4Addr::new(100, 101, 102, 103));
        let ts_v6 = IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1));
        assert!(is_tailscale_ip(ts_v4));
        assert!(is_tailscale_ip(ts_v6));
        assert!(is_webrtc_host_candidate_eligible("utun2", ts_v4));
        assert!(is_webrtc_host_candidate_eligible("tailscale0", ts_v4));
        assert!(is_webrtc_host_candidate_eligible("utun2", ts_v6));
    }

    #[test]
    fn bind_udp_socket_to_interface_rejects_nonexistent_interface() {
        use std::net::{Ipv4Addr, UdpSocket};

        use super::bind_udp_socket_to_interface;

        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("bind udp");
        let err = bind_udp_socket_to_interface(&socket, "vibex_nonexistent_if99")
            .expect_err("nonexistent interface must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }
}
