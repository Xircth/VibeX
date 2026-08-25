#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))


def unused_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def wait_listen(port, timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        sock = socket.socket()
        sock.settimeout(0.2)
        try:
            sock.connect(("127.0.0.1", port))
            sock.close()
            return
        except Exception:
            sock.close()
            time.sleep(0.05)
    raise RuntimeError("tunnel did not listen on %s" % port)


def http_get(url, timeout=2.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def main():
    port = unused_port()
    process = subprocess.Popen(
        [
            sys.executable,
            os.path.join(ROOT, "tunnel.py"),
            "--token",
            "vbx_tun_test",
            "--port",
            str(port),
            "--bind",
            "127.0.0.1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_listen(port)
        started = time.time()
        status, body = http_get("http://127.0.0.1:%s/health" % port)
        elapsed = time.time() - started
        payload = json.loads(body)
        assert status == 502, status
        assert payload["reason"] == "host offline", payload
        assert elapsed < 1.5, elapsed
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
