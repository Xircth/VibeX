package dev.vibex.companion

import java.net.URI

data class HostOrigin(val value: String) {
    fun resolve(path: String): String {
        val suffix = if (path.startsWith("/")) path else "/$path"
        return value + suffix
    }

    companion object {
        fun parse(raw: String): HostOrigin {
            val trimmed = raw.trim().trimEnd('/')
            require(trimmed.isNotEmpty()) { "Host origin is required" }
            val uri = try {
                URI(trimmed)
            } catch (error: Exception) {
                throw IllegalArgumentException("Host origin is not a valid URI", error)
            }
            require(uri.scheme == "http" || uri.scheme == "https") {
                "Host origin must be http or https"
            }
            require(uri.host.isNullOrBlank().not()) { "Host origin must include a host" }
            require(uri.userInfo == null) { "Host origin must not include credentials" }
            require(uri.query == null) { "Host origin must not include a query string" }
            require(uri.fragment == null) { "Host origin must not include a fragment" }
            val port = if (uri.port == -1) "" else ":${uri.port}"
            val path = uri.path.orEmpty().trimEnd('/')
            return HostOrigin("${uri.scheme}://${uri.host}$port$path")
        }
    }
}
