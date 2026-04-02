#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "click",
#   "loguru",
# ]
# ///
"""
check_connection.py — Test reachability of STUN/STUNS/TURN/TURNS servers.

Sends an unauthenticated STUN Binding (STUN/STUNS) or TURN Allocate
(TURN/TURNS) request.  A 401 Unauthorized from TURN still means the
server is up.  A successful Binding response from STUN means it's up.

Usage:
    uv run check_connection.py --type stun   <host> <port>
    uv run check_connection.py --type stuns  <host> <port>
    uv run check_connection.py --type turn   <host> <port>
    uv run check_connection.py --type turns  <host> <port>

Written with the help of Claude Code.
"""

import os
import socket
import ssl
import struct
import sys
import time

import click
from loguru import logger

# STUN magic cookie (RFC 5389)
MAGIC_COOKIE = 0x2112A442

# STUN message types
MSG_BINDING_REQUEST   = 0x0001
MSG_BINDING_SUCCESS   = 0x0101
MSG_BINDING_ERROR     = 0x0111
MSG_ALLOCATE_REQUEST  = 0x0003
MSG_ALLOCATE_SUCCESS  = 0x0103
MSG_ALLOCATE_ERROR    = 0x0113

# STUN error codes we care about
ERR_UNAUTHORIZED      = 401
ERR_FORBIDDEN         = 403


def build_stun_binding_request() -> bytes:
    """Build a STUN Binding request (RFC 5389)."""
    transaction_id = os.urandom(12)
    return struct.pack(">HHI", MSG_BINDING_REQUEST, 0, MAGIC_COOKIE) + transaction_id


def build_allocate_request() -> bytes:
    """Build a minimal unauthenticated TURN Allocate request (RFC 5766)."""
    transaction_id = os.urandom(12)
    return struct.pack(">HHI", MSG_ALLOCATE_REQUEST, 0, MAGIC_COOKIE) + transaction_id


def parse_response(data: bytes) -> tuple[int, int | None, str]:
    """Parse a STUN/TURN response.

    Returns (msg_type, error_code_or_None, description).
    """
    if len(data) < 20:
        return -1, None, f"Response too short ({len(data)} bytes)"

    msg_type, msg_len, magic = struct.unpack_from(">HHI", data, 0)

    if magic != MAGIC_COOKIE:
        return msg_type, None, f"Unexpected magic cookie: 0x{magic:08X}"

    if msg_type == MSG_BINDING_SUCCESS:
        # Try to extract XOR-MAPPED-ADDRESS (0x0020) for the reflexive address
        offset = 20
        while offset + 4 <= 20 + msg_len:
            attr_type, attr_len = struct.unpack_from(">HH", data, offset)
            attr_val = data[offset + 4 : offset + 4 + attr_len]
            if attr_type == 0x0020 and len(attr_val) >= 8:
                family = attr_val[1]
                xport = struct.unpack_from(">H", attr_val, 2)[0] ^ (MAGIC_COOKIE >> 16)
                if family == 0x01:  # IPv4
                    xip = struct.unpack_from(">I", attr_val, 4)[0] ^ MAGIC_COOKIE
                    ip_str = socket.inet_ntoa(struct.pack(">I", xip))
                    return msg_type, None, f"Binding SUCCESS — your reflexive address is {ip_str}:{xport}"
            offset += 4 + attr_len + (4 - attr_len % 4) % 4
        return msg_type, None, "Binding SUCCESS (could not parse reflexive address)"

    if msg_type == MSG_BINDING_ERROR:
        return msg_type, None, "Binding ERROR"

    if msg_type == MSG_ALLOCATE_SUCCESS:
        return msg_type, None, "Allocate SUCCESS — TURN server accepted without auth"

    if msg_type == MSG_ALLOCATE_ERROR:
        offset = 20
        while offset + 4 <= 20 + msg_len:
            attr_type, attr_len = struct.unpack_from(">HH", data, offset)
            attr_val = data[offset + 4 : offset + 4 + attr_len]
            if attr_type == 0x0009 and len(attr_val) >= 4:
                cls    = attr_val[2] & 0x07
                num    = attr_val[3]
                code   = cls * 100 + num
                reason = attr_val[4:].decode("utf-8", errors="replace").strip()
                return msg_type, code, f"Allocate ERROR {code}: {reason}"
            offset += 4 + attr_len + (4 - attr_len % 4) % 4
        return msg_type, None, "Allocate ERROR (could not parse error code)"

    return msg_type, None, f"Unexpected message type: 0x{msg_type:04X}"


def test_stun_udp(host: str, port: int, timeout: float) -> bool:
    """Test a plain STUN server over UDP."""
    logger.info(f"Testing STUN (UDP) at {host}:{port} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        request = build_stun_binding_request()
        t0 = time.monotonic()
        sock.sendto(request, (host, port))
        response, _ = sock.recvfrom(4096)
        rtt = (time.monotonic() - t0) * 1000
        logger.debug(f"Got {len(response)} bytes in {rtt:.1f} ms")

        msg_type, _, description = parse_response(response)
        logger.info(f"Response: {description}")

        if msg_type == MSG_BINDING_SUCCESS:
            logger.success(f"STUN server is REACHABLE ({rtt:.1f} ms)")
            return True
        else:
            logger.error(f"STUN server responded unexpectedly: {description}")
            return False
    except TimeoutError:
        logger.error(f"No response after {timeout}s — UDP blocked or server down")
        return False
    except OSError as e:
        logger.error(f"Network error: {e}")
        return False
    finally:
        sock.close()


def test_tcp(host: str, port: int, *, use_tls: bool, is_turn: bool, timeout: float) -> bool:
    """Test a STUN/TURN server over TCP or TLS."""
    if is_turn:
        proto = "TURNS (TLS)" if use_tls else "TURN (TCP)"
    else:
        proto = "STUNS (TLS)" if use_tls else "STUN (TCP)"

    logger.info(f"Testing {proto} at {host}:{port} ...")

    raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raw_sock.settimeout(timeout)

    try:
        t0 = time.monotonic()
        raw_sock.connect((host, port))
        rtt_connect = (time.monotonic() - t0) * 1000

        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            logger.warning("TLS certificate verification is DISABLED — suitable for dev/self-signed only")
            sock: socket.socket = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock

        logger.debug(f"Connected in {rtt_connect:.1f} ms")

        request = build_allocate_request() if is_turn else build_stun_binding_request()
        sock.sendall(request)

        response = sock.recv(4096)
        rtt_total = (time.monotonic() - t0) * 1000
        logger.debug(f"Got {len(response)} bytes in {rtt_total:.1f} ms total")

        msg_type, error_code, description = parse_response(response)
        logger.info(f"Response: {description}")

        if is_turn:
            if msg_type == MSG_ALLOCATE_SUCCESS:
                logger.success(f"{proto} server is REACHABLE and allocated without credentials.")
                return True
            elif msg_type == MSG_ALLOCATE_ERROR and error_code in (ERR_UNAUTHORIZED, ERR_FORBIDDEN):
                logger.success(f"{proto} server is REACHABLE (error {error_code} = alive, wants credentials).")
                return True
            else:
                logger.error(f"{proto} server responded unexpectedly: {description}")
                return False
        else:
            if msg_type == MSG_BINDING_SUCCESS:
                logger.success(f"{proto} server is REACHABLE ({rtt_total:.1f} ms)")
                return True
            else:
                logger.error(f"{proto} server responded unexpectedly: {description}")
                return False

    except ssl.SSLError as e:
        logger.error(f"TLS handshake failed: {e}")
        return False
    except ConnectionRefusedError:
        logger.error(f"Connection refused on {host}:{port}")
        return False
    except TimeoutError:
        logger.error(f"Connection timed out after {timeout}s")
        return False
    except OSError as e:
        logger.error(f"Network error: {e}")
        return False
    finally:
        try:
            raw_sock.close()
        except Exception:
            pass


@click.command()
@click.argument("host")
@click.argument("port", type=int)
@click.option(
    "--type", "proto_type", required=True,
    type=click.Choice(["stun", "stuns", "turn", "turns"], case_sensitive=False),
    help="Protocol to test.",
)
@click.option("--timeout", default=5.0, show_default=True, help="Socket timeout in seconds.")
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging.")
def main(host: str, port: int, proto_type: str, timeout: float, verbose: bool) -> None:
    """Check whether a STUN/STUNS/TURN/TURNS server is reachable.

    \b
    Examples:
        uv run check_connection.py --type stun   stun.l.google.com 19302
        uv run check_connection.py --type stuns  myrelay.example.com 5349
        uv run check_connection.py --type turn   myrelay.example.com 3478
        uv run check_connection.py --type turns  myrelay.example.com 5349
    """
    level = "DEBUG" if verbose else "INFO"
    logger.remove()
    logger.add(sys.stderr, level=level, colorize=True, format="<level>{level:<8}</level> {message}")

    proto_type = proto_type.lower()

    if proto_type == "stun":
        ok = test_stun_udp(host=host, port=port, timeout=timeout)
    elif proto_type == "stuns":
        ok = test_tcp(host=host, port=port, use_tls=True, is_turn=False, timeout=timeout)
    elif proto_type == "turn":
        ok = test_tcp(host=host, port=port, use_tls=False, is_turn=True, timeout=timeout)
    elif proto_type == "turns":
        ok = test_tcp(host=host, port=port, use_tls=True, is_turn=True, timeout=timeout)
    else:
        raise click.BadParameter(f"Unknown type: {proto_type}")

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
