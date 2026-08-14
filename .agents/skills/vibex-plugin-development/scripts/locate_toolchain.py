#!/usr/bin/env python3
"""Locate the repository-local VibeX plugin contract without network access."""

from __future__ import annotations

import json
from pathlib import Path
import sys


def main() -> int:
    root = find_root(Path.cwd())
    if root is None:
        print(json.dumps({"error": "vibex_repository_not_found"}))
        return 1
    required = [
        root / "packages/plugin-sdk/src/manifest.ts",
        root / "packages/plugin-sdk/src/protocol.ts",
        root / "packages/plugin-sdk/src/worker.ts",
        root / "packages/plugin-sdk/src/app.ts",
        root / "packages/plugin-sdk/src/testing.ts",
        root / "packages/plugin-cli/src/validation.ts",
        root / "docs/plugins/package-v4.md",
        root / "docs/plugins/sdk-and-cli.md",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    print(
        json.dumps(
            {
                "repository": str(root),
                "required": [str(path) for path in required],
                "cli": str(root / "packages/plugin-cli/dist/cli.js"),
                "missing": missing,
            },
            indent=2,
        )
    )
    return 1 if missing else 0


def find_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        if (candidate / "CONTEXT.md").is_file() and (candidate / "packages/plugin-sdk").is_dir():
            return candidate
    return None


if __name__ == "__main__":
    sys.exit(main())
