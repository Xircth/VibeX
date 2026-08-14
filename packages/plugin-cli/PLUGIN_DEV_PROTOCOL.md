# VibeX Plugin Dev Control Protocol 1.0

The Plugin CLI uses this loopback-only control protocol for linked development.
It is separate from VibeX user/session authentication.

## Connection and authentication

- The endpoint is an HTTP origin whose host is exactly `localhost`,
  `127.0.0.1`, or `::1`. Userinfo, paths, query strings, fragments, HTTPS, and
  non-loopback hosts are rejected by the CLI.
- The CLI reads the endpoint only from `--host` or `VIBEX_PLUGIN_DEV_HOST`.
- The CLI reads the opaque token only from `--token` or
  `VIBEX_PLUGIN_DEV_TOKEN`. It never reads or sends the main VibeX bearer.
- Every request sends `X-VibeX-Plugin-Dev-Protocol: 1.0` and
  `X-VibeX-Plugin-Dev-Token: <opaque token>`.
- The Host must bind the listener to loopback, compare the token without
  timing leaks, cap request bodies, reject non-JSON bodies, and never log the
  token.

JSON responses from successful requests contain `"protocolVersion": "1.0"`.
The CLI rejects any other version.

## Linked installation

`POST /api/plugin-dev/v1/linked-installations`

```json
{
  "sourcePath": "/canonical/absolute/plugin/directory",
  "expected": {
    "publisher": "acme",
    "pluginId": "notes",
    "version": "1.0.0",
    "packageDigest": "hex-sha256"
  }
}
```

The Host canonicalizes `sourcePath`, requires a directory, reads the package
itself, validates it, computes its digest independently, and compares every
`expected` field. The request is evidence against a confused-deputy error, not
an authority for identity or content.

Installing or linking a package is the trust decision. Plugin Worker, App code,
and declared Runtime processes execute with the current user's full Host access;
there is no per-capability consent or `--grant` step. Candidate reloads keep the
same full-trust execution model while preserving generation rollback semantics.

`packageDigest` uses the CLI package-lock algorithm: sort normalized relative
file paths; exclude `.git`, `node_modules`, `.vxp` archives,
`.vibex-plugin/package.lock.json`, and
`.vibex-plugin/developer-link.json`; SHA-256 every file; then SHA-256 the UTF-8
rows `path + NUL + byte-size + NUL + file-sha256` joined with LF. The Host and
CLI must reject symlinks rather than following them.

Success:

```json
{
  "protocolVersion": "1.0",
  "plugin": { "publisher": "acme", "id": "notes" },
  "generation": 1,
  "packageDigest": "hex-sha256",
  "state": "active"
}
```

## Candidate reload

`POST /api/plugin-dev/v1/plugins/{publisher}/{id}/candidates`

```json
{
  "sourcePath": "/canonical/absolute/plugin/directory",
  "expectedPackageDigest": "hex-sha256"
}
```

The Host repeats canonicalization, validation, identity, and digest checks. It
prepares and activates an invisible candidate before atomically publishing the
new generation. A rejected candidate must leave the previous published
generation active. Success uses the linked-installation response shape.

## Uninstall

`DELETE /api/plugin-dev/v1/plugins/{publisher}/{id}/linked-installation`

```json
{ "retainData": true }
```

Success:

```json
{
  "protocolVersion": "1.0",
  "plugin": { "publisher": "acme", "id": "notes" },
  "removed": true,
  "dataRetention": "retained"
}
```

`dataRetention` is `retained` or `deleted`. CLI `uninstall` retains data by
default; `--delete-data` is explicit.

## Doctor

`GET /api/plugin-dev/v1/plugins/{publisher}/{id}/doctor`

```json
{
  "protocolVersion": "1.0",
  "plugin": { "publisher": "acme", "id": "notes" },
  "installation": {},
  "activation": {},
  "grants": [],
  "runtimes": [],
  "surfaces": [],
  "agentBindings": [],
  "recentCrashes": [],
  "diagnostics": [
    { "code": "stable_code", "severity": "warning", "message": "..." }
  ]
}
```

All inventory arrays are present even when empty. The CLI exits with status 1
when any diagnostic has severity `error`.

## Errors

All non-2xx responses use:

```json
{
  "error": {
    "code": "stable_code",
    "message": "diagnostic-safe message",
    "retryable": false,
    "diagnosticId": "optional-id",
    "publishedGeneration": 4,
    "details": null
  }
}
```

Candidate errors include `publishedGeneration` when a prior generation remains
active. Error messages and details must not contain tokens, secrets, private
artifact contents, or another plugin's paths.
