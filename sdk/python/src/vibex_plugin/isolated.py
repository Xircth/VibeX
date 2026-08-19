"""Isolated package-class worker API.

`define_plugin_worker` is the same contract as Full Trust. Filesystem, network,
and subprocess helpers are not exported from this module. The Host OS sandbox
rejects those operations even if a Worker imports the language standard library.
"""

from vibex_plugin.stdio import run_stdio_plugin_worker, run_stdio_plugin_worker_async
from vibex_plugin.worker import (
    PLUGIN_API_VERSION,
    PLUGIN_PROTOCOL_VERSION,
    PLUGIN_SDK_VERSION,
    PluginSdkError,
    PluginWorkerEnvironment,
    PluginWorkerRegistrar,
    activate_plugin_worker,
    define_plugin_worker,
)

__all__ = [
    "PLUGIN_API_VERSION",
    "PLUGIN_PROTOCOL_VERSION",
    "PLUGIN_SDK_VERSION",
    "PluginSdkError",
    "PluginWorkerEnvironment",
    "PluginWorkerRegistrar",
    "activate_plugin_worker",
    "define_plugin_worker",
    "run_stdio_plugin_worker",
    "run_stdio_plugin_worker_async",
]
