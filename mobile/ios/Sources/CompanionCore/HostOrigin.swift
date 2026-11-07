import Foundation

public struct HostOrigin: Equatable, Sendable {
    public let value: String

    public func resolve(_ path: String) -> String {
        value + (path.hasPrefix("/") ? path : "/" + path)
    }

    public static func parse(_ raw: String) throws -> HostOrigin {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { throw PairingError.invalidOrigin("Host origin is required") }
        guard let components = URLComponents(string: trimmed) else {
            throw PairingError.invalidOrigin("Host origin is not a valid URI")
        }
        guard components.scheme == "http" || components.scheme == "https" else {
            throw PairingError.invalidOrigin("Host origin must be http or https")
        }
        guard let host = components.host, !host.isEmpty else {
            throw PairingError.invalidOrigin("Host origin must include a host")
        }
        guard components.user == nil, components.password == nil else {
            throw PairingError.invalidOrigin("Host origin must not include credentials")
        }
        guard components.query == nil else {
            throw PairingError.invalidOrigin("Host origin must not include a query string")
        }
        guard components.fragment == nil else {
            throw PairingError.invalidOrigin("Host origin must not include a fragment")
        }
        let hostPart = host.contains(":") ? "[\(host)]" : host
        let port = components.port.map { ":\($0)" } ?? ""
        return HostOrigin(value: "\(components.scheme!)://\(hostPart)\(port)\(components.path)")
    }
}
