#!/usr/bin/env python3
# VibeX public tunnel server. Stdlib only. Python 3.6+.
from __future__ import print_function

import argparse
import os
import select
import socket
import sys
import threading
import uuid

control_lock = threading.Lock()
control_sock = None
pending_lock = threading.Lock()
pending = {}
status_file = None


def write_host_status(value):
    if not status_file:
        return
    directory = os.path.dirname(status_file)
    try:
        if directory and not os.path.isdir(directory):
            os.makedirs(directory)
        tmp = status_file + ".tmp"
        with open(tmp, "w") as handle:
            handle.write(value + "\n")
        os.rename(tmp, status_file)
    except Exception:
        pass


def log(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def close_quietly(sock):
    try:
        sock.close()
    except Exception:
        pass


def prepare_sock(sock):
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    except Exception:
        pass


def send_http_status(sock, status, reason):
    body = ('{"status":"unavailable","reason":"%s"}' % reason).encode("ascii")
    header = (
        "HTTP/1.1 %s\r\nContent-Type: application/json\r\n"
        "Content-Length: %d\r\nConnection: close\r\n\r\n" % (status, len(body))
    )
    try:
        sock.sendall(header.encode("ascii") + body)
    except Exception:
        pass
    close_quietly(sock)


def splice(left, right):
    sockets = [left, right]
    try:
        while True:
            readable, _, failed = select.select(sockets, [], sockets, 120)
            if failed:
                return
            if not readable:
                continue
            for src in readable:
                dst = right if src is left else left
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    finally:
        close_quietly(left)
        close_quietly(right)


def register_control(sock):
    global control_sock
    with control_lock:
        previous = control_sock
        control_sock = sock
    close_quietly(previous)
    write_host_status("connected")
    log("host registered")
    try:
        while True:
            data = sock.recv(1024)
            if not data:
                break
    finally:
        with control_lock:
            if control_sock is sock:
                control_sock = None
                write_host_status("waiting")
        close_quietly(sock)
        log("host disconnected")


def attach_data(conn_id, data_sock, extra):
    with pending_lock:
        item = pending.pop(conn_id, None)
    if item is None:
        close_quietly(data_sock)
        return
    public_sock, buffered, event = item
    event.set()
    payload = buffered + extra
    if payload:
        try:
            data_sock.sendall(payload)
        except Exception:
            close_quietly(public_sock)
            close_quietly(data_sock)
            return
    splice(public_sock, data_sock)


def handle_public(sock, buffered):
    conn_id = uuid.uuid4().hex[:16]
    event = threading.Event()
    with pending_lock:
        pending[conn_id] = (sock, buffered, event)
    with control_lock:
        current = control_sock
    if current is None:
        with pending_lock:
            pending.pop(conn_id, None)
        send_http_status(sock, "502 Bad Gateway", "host offline")
        return
    try:
        current.sendall(("OPEN %s\n" % conn_id).encode("ascii"))
    except Exception:
        with pending_lock:
            pending.pop(conn_id, None)
        send_http_status(sock, "502 Bad Gateway", "host offline")
        return
    if not event.wait(8):
        with pending_lock:
            pending.pop(conn_id, None)
        send_http_status(sock, "504 Gateway Timeout", "host did not accept")


def recv_prefix(sock):
    buf = b""
    sock.settimeout(20)
    while b"\n" not in buf and len(buf) < 2048:
        chunk = sock.recv(1)
        if not chunk:
            break
        buf += chunk
    sock.settimeout(None)
    return buf


def handle_client(sock, token):
    try:
        prefix = recv_prefix(sock)
        if prefix.startswith(b"VIBEX-CTRL ") or prefix.startswith(b"VIBEX-DATA "):
            line, extra = prefix.split(b"\n", 1) if b"\n" in prefix else (prefix, b"")
            text = line.decode("ascii", "replace").strip()
            parts = text.split(" ")
            if parts[0] == "VIBEX-CTRL" and len(parts) == 2 and parts[1] == token:
                register_control(sock)
                return
            if parts[0] == "VIBEX-DATA" and len(parts) == 3 and parts[1] == token:
                attach_data(parts[2], sock, extra)
                return
            close_quietly(sock)
            return
        handle_public(sock, prefix)
    except Exception:
        close_quietly(sock)


def serve(bind, port, token):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((bind, port))
    except OSError as error:
        log("cannot bind %s:%s (%s); use root for ports below 1024" % (bind, port, error))
        sys.exit(1)
    server.listen(128)
    write_host_status("waiting")
    log("VibeX tunnel listening on %s:%s" % (bind, port))
    while True:
        sock, _addr = server.accept()
        prepare_sock(sock)
        worker = threading.Thread(target=handle_client, args=(sock, token))
        worker.daemon = True
        worker.start()


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--status-file", default="")
    args = parser.parse_args()
    global status_file
    status_file = args.status_file or None
    if args.port <= 0 or args.port > 65535:
        log("invalid port")
        sys.exit(1)
    write_host_status("waiting")
    serve(args.bind, args.port, args.token)


if __name__ == "__main__":
    main()
