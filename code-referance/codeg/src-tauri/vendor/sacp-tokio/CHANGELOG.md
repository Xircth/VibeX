# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [11.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v10.1.0...sacp-tokio-v11.0.0) - 2026-01-19

### Other

- go back from `connect_from` to `builder`
- fix unresolved rustdoc link warnings for v11 API
- *(sacp)* [**breaking**] rename *_cx variables to descriptive names
- *(sacp)* [**breaking**] rename MessageCx to Dispatch for clearer semantics
- *(sacp)* [**breaking**] rename Serve to ConnectTo for clearer semantics
- *(sacp)* [**breaking**] replace JrLink/JrPeer with unified Role-based API
- *(sacp)* rename JrConnectionBuilder to ConnectFrom
- *(sacp)* rename Jr* traits to JsonRpc* for clarity

## [10.1.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v10.0.0...sacp-tokio-v10.1.0) - 2025-12-31

### Added

- *(elizacp)* implement Eliza algorithm based on the original style

## [10.0.0-alpha.4](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v10.0.0-alpha.3...sacp-tokio-v10.0.0-alpha.4) - 2025-12-30

### Added

- *(deps)* [**breaking**] upgrade agent-client-protocol-schema to 0.10.5

## [10.0.0-alpha.3](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v10.0.0-alpha.2...sacp-tokio-v10.0.0-alpha.3) - 2025-12-29

### Other

- updated the following local packages: sacp

## [10.0.0-alpha.2](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v10.0.0-alpha.1...sacp-tokio-v10.0.0-alpha.2) - 2025-12-29

### Other

- updated the following local packages: sacp

## [10.0.0-alpha.1](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v9.0.0...sacp-tokio-v10.0.0-alpha.1) - 2025-12-28

### Other

- [**breaking**] split peer.rs into separate peer and link modules
- [**breaking**] update module and documentation references from role to peer
- [**breaking**] give component a link
- update UntypedRole to UntypedRole in doc examples
- *(sacp)* rename with_client to run_until
- update references for renamed methods

## [9.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v8.0.0...sacp-tokio-v9.0.0) - 2025-12-19

### Added

- *(sacp-tokio)* add convenience constructors for known ACP agents

## [8.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v7.0.0...sacp-tokio-v8.0.0) - 2025-12-17

### Other

- updated the following local packages: sacp

## [6.0.1](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v6.0.0...sacp-tokio-v6.0.1) - 2025-12-17

### Other

- updated the following local packages: sacp

## [3.0.1](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v3.0.0...sacp-tokio-v3.0.1) - 2025-12-15

### Fixed

- *(sacp-tokio)* report child process errors with stderr in AcpAgent

## [3.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v2.0.1...sacp-tokio-v3.0.0) - 2025-12-12

### Added

- [**breaking**] introduce role-based connection API

## [2.0.1](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v2.0.0...sacp-tokio-v2.0.1) - 2025-11-25

### Other

- updated the following local packages: sacp

## [2.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.1.0...sacp-tokio-v2.0.0) - 2025-11-22

### Added

- *(sacp-tokio)* add debug callback support to Stdio component
- *(sacp-tokio)* capture stderr in AcpAgent debug logging
- *(sacp-tokio)* add debug callback support to AcpAgent

### Changed

- [**breaking**] `Stdio` is no longer a unit struct. Use `Stdio::new()` instead of `Stdio` to instantiate.

### Other

- *(sacp-tokio)* simplify debug callback using Option instead of wrapper type
- *(sacp-tokio)* rewrite AcpAgent to use Lines instead of ByteStreams

## [1.1.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0...sacp-tokio-v1.1.0) - 2025-11-22

### Added

- *(sacp-tokio)* add debug callback support to Stdio component
- *(sacp-tokio)* capture stderr in AcpAgent debug logging
- *(sacp-tokio)* add debug callback support to AcpAgent

### Other

- *(sacp-tokio)* simplify debug callback using Option instead of wrapper type
- *(sacp-tokio)* rewrite AcpAgent to use Lines instead of ByteStreams

## [1.0.0](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.8...sacp-tokio-v1.0.0) - 2025-11-13

### Other

- updated the following local packages: sacp

## [1.0.0-alpha.8](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.7...sacp-tokio-v1.0.0-alpha.8) - 2025-11-12

### Other

- Merge pull request #30 from nikomatsakis/main
- *(sacp)* add Component::serve() and simplify channel API

## [1.0.0-alpha.7](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.6...sacp-tokio-v1.0.0-alpha.7) - 2025-11-12

### Other

- Merge pull request #28 from nikomatsakis/main

## [1.0.0-alpha.6](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.5...sacp-tokio-v1.0.0-alpha.6) - 2025-11-11

### Other

- Merge pull request #26 from nikomatsakis/main
- [**breaking**] make Component trait ergonomic with async fn and introduce DynComponent
- [**breaking**] make Component the primary trait with Transport as blanket impl

## [1.0.0-alpha.5](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.4...sacp-tokio-v1.0.0-alpha.5) - 2025-11-11

### Other

- convert Stdio to unit struct for easier reference

## [1.0.0-alpha.4](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.3...sacp-tokio-v1.0.0-alpha.4) - 2025-11-11

### Other

- remove ComponentProvider trait
- unify Transport and Component traits with BoxFuture-returning signatures
- create selective jsonrpcmsg re-export module
- replace jsonrpcmsg::Message with sacp::JsonRpcMessage throughout codebase

## [1.0.0-alpha.3](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.2...sacp-tokio-v1.0.0-alpha.3) - 2025-11-09

### Other

- updated the following local packages: sacp

## [1.0.0-alpha.2](https://github.com/symposium-dev/symposium-acp/compare/sacp-tokio-v1.0.0-alpha.1...sacp-tokio-v1.0.0-alpha.2) - 2025-11-08

### Other

- fix doctests for API refactoring
- wip wip wip
- [**breaking**] remove Unpin bounds and simplify transport API

## [1.0.0-alpha](https://github.com/symposium-dev/symposium-acp/releases/tag/sacp-tokio-v1.0.0-alpha) - 2025-11-05

### Added

- *(conductor)* add proxy mode support for hierarchical chains
- *(sacp-tokio)* implement JrConnectionExt trait for to_agent
- create sacp-tokio crate and improve AcpAgent API

### Fixed

- *(sacp-tokio)* correct type path in doctest example
- fix github url

### Other

- bump all packages to version 1.0.0-alpha
- *(sacp)* move handler types to dedicated handler module
- *(sacp)* [**breaking**] reorganize modules with flat schema namespace
- release
- add READMEs for sacp-tokio, sacp-proxy, and sacp-conductor

## [0.1.1](https://github.com/symposium-dev/symposium-acp/releases/tag/sacp-tokio-v0.1.1) - 2025-11-04

### Added

- *(sacp-tokio)* implement JrConnectionExt trait for to_agent
- create sacp-tokio crate and improve AcpAgent API

### Fixed

- fix github url

### Other

- add READMEs for sacp-tokio, sacp-proxy, and sacp-conductor
