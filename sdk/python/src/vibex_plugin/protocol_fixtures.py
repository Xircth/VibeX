"""Replay protocol 1.1 JSONL fixtures against an in-process hello worker."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from vibex_plugin.stdio import PluginWorkerSession
from vibex_plugin.worker import PluginWorkerDefinition, define_plugin_worker


@dataclass(frozen=True)
class ProtocolStep:
    direction: str
    message: dict[str, Any]


@dataclass
class ProtocolFixture:
    path: Path
    steps: list[ProtocolStep]


def hello_plugin_worker() -> PluginWorkerDefinition:
    def setup(registrar, _environment) -> None:
        registrar.handle("hello", lambda value, _env: value)

    return define_plugin_worker(setup)


def default_fixture_directory() -> Path:
    here = Path(__file__).resolve()
    for parent in [Path.cwd(), *here.parents]:
        candidate = parent / "packages" / "plugin-contract" / "fixtures" / "protocol"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(
        "Could not locate packages/plugin-contract/fixtures/protocol"
    )


def load_protocol_fixtures(directory: Path | None = None) -> list[ProtocolFixture]:
    root = directory or default_fixture_directory()
    fixtures: list[ProtocolFixture] = []
    for path in sorted(root.glob("*.jsonl")):
        steps: list[ProtocolStep] = []
        for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON") from error
            if record.get("dir") not in {"in", "out"} or "message" not in record:
                raise ValueError(f"{path}:{line_number}: expected dir/message")
            steps.append(ProtocolStep(record["dir"], record["message"]))
        fixtures.append(ProtocolFixture(path, steps))
    return fixtures


async def replay_fixture(
    fixture: ProtocolFixture,
    definition: PluginWorkerDefinition | None = None,
) -> None:
    outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def send(message: dict[str, Any]) -> None:
        await outbound.put(message)

    session = PluginWorkerSession(definition or hello_plugin_worker(), send)
    try:
        for index, step in enumerate(fixture.steps):
            if step.direction == "in":
                await session.handle_message(step.message)
                continue
            if step.direction != "out":
                raise AssertionError(f"{fixture.path}: unknown direction {step.direction}")
            try:
                actual = await asyncio.wait_for(outbound.get(), timeout=5)
            except TimeoutError as error:
                raise AssertionError(
                    f"{fixture.path} step {index}: timed out waiting for {step.message}"
                ) from error
            if actual != step.message:
                raise AssertionError(
                    f"{fixture.path} step {index}:\n"
                    f" expected {json.dumps(step.message, ensure_ascii=False)}\n"
                    f" actual   {json.dumps(actual, ensure_ascii=False)}"
                )
        if not outbound.empty():
            leftover = outbound.get_nowait()
            raise AssertionError(f"{fixture.path}: unexpected extra message {leftover}")
    finally:
        await session.close()


async def replay_protocol_fixtures(directory: Path | None = None) -> list[str]:
    failures: list[str] = []
    for fixture in load_protocol_fixtures(directory):
        try:
            await replay_fixture(fixture)
        except Exception as error:  # noqa: BLE001 — collect all fixture failures
            failures.append(f"{fixture.path}: {error}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay VibeX plugin protocol fixtures")
    parser.add_argument(
        "directory",
        nargs="?",
        type=Path,
        default=None,
        help="Directory of protocol *.jsonl fixtures",
    )
    args = parser.parse_args(argv)
    directory = args.directory or default_fixture_directory()
    failures = asyncio.run(replay_protocol_fixtures(directory))
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print(f"ok {directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
