//! Portable LAN interface discovery for Host reachability.

use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
};

pub fn is_advertisable_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !ip.is_multicast()
}

/// IPv4 addresses that a Host may advertise as LAN reachability.
///
/// Combines a UDP route probe with OS interface enumeration so offline or
/// multi-homed machines still surface every usable LAN address.
pub fn lan_ipv4_addrs() -> Vec<Ipv4Addr> {
    let mut addrs = BTreeSet::new();
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        && socket.connect((Ipv4Addr::new(1, 1, 1, 1), 80)).is_ok()
        && let Ok(SocketAddr::V4(addr)) = socket.local_addr()
        && is_advertisable_ipv4(*addr.ip())
    {
        addrs.insert(*addr.ip());
    }
    addrs.extend(interface_ipv4_addrs());
    addrs.into_iter().collect()
}

pub fn advertised_http_origins(port: u16, allow_lan: bool) -> Vec<String> {
    let mut addresses = vec![format!("http://127.0.0.1:{port}")];
    if !allow_lan {
        return addresses;
    }
    for ip in lan_ipv4_addrs() {
        let candidate = format!("http://{ip}:{port}");
        if !addresses.contains(&candidate) {
            addresses.push(candidate);
        }
    }
    addresses
}

pub fn listen_allows_lan(listen_addr: SocketAddr) -> bool {
    match listen_addr.ip() {
        IpAddr::V4(ip) => is_advertisable_ipv4(ip),
        IpAddr::V6(ip) => !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast()),
    }
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
fn interface_ipv4_addrs() -> Vec<Ipv4Addr> {
    let mut addrs = Vec::new();
    let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut ifap) } != 0 || ifap.is_null() {
        return addrs;
    }
    let mut cursor = ifap;
    while !cursor.is_null() {
        let entry = unsafe { &*cursor };
        if !entry.ifa_addr.is_null()
            && unsafe { (*entry.ifa_addr).sa_family as i32 } == libc::AF_INET
        {
            let sin = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
            if is_advertisable_ipv4(ip) {
                addrs.push(ip);
            }
        }
        cursor = entry.ifa_next;
    }
    unsafe { libc::freeifaddrs(ifap) };
    addrs
}

#[cfg(windows)]
fn interface_ipv4_addrs() -> Vec<Ipv4Addr> {
    use windows_sys::Win32::{
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
                GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, SOCKADDR_IN},
    };

    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    unsafe {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size = 0_u32;
        let first = GetAdaptersAddresses(
            AF_INET as u32,
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
            AF_INET as u32,
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
                let mut unicast = adapter.FirstUnicastAddress;
                while !unicast.is_null() {
                    let address = &*unicast;
                    let sockaddr = address.Address.lpSockaddr;
                    if !sockaddr.is_null() && (*sockaddr).sa_family == AF_INET {
                        let sin = &*(sockaddr.cast::<SOCKADDR_IN>());
                        let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                        if is_advertisable_ipv4(ip) {
                            addrs.push(ip);
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

#[cfg(not(any(unix, windows)))]
fn interface_ipv4_addrs() -> Vec<Ipv4Addr> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{
        advertised_http_origins, is_advertisable_ipv4, is_trusted_http_host, lan_ipv4_addrs,
        lan_probe_ipv4s,
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
}
