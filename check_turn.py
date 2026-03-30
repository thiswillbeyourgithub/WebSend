#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "click",
#   "loguru",
# ]
# ///
"""
check_turn.py — Test reachability of a TURN or TURNS (TURN over TLS) server.

Sends an unauthenticated STUN Allocate request over TCP (plain or TLS).
A 401 Unauthorized response still means the server is up and responding
correctly — it just wants credentials, which is expected.

Usage:
    uv run check_turn.py --turn-server  <host> <port>
    uv run check_turn.py --turns-server <host> <port>
"""

import os
import socket
import ssl
import struct
import os
import sys
import time

import click
from loguru import logger

# STUN magic cookie (RFC 5389)
MAGIC_COOKIE = 0x2112A442

# STUN message types
MSG_ALLOCATE_REQUEST  = 0x0003
MSG_ALLOCATE_SUCCESS  = 0x0103
MSG_ALLOCATE_ERROR    = 0x0113

# STUN error codes we care about
ERR_UNAUTHORIZED      = 401
ERR_FORBIDDEN         = 403


def build_allocate_request() -> bytes:
    """Build a minimal unauthenticated TURN Allocate request (RFC 5766).

    The server will reply with a 401 + REALM + NONCE challenge.
    That response alone proves the TURN server is reachable and working.
    """
    transaction_id = os.urandom(12)
    # Header: type (2B) + length (2B, 0 = no attributes) + magic (4B) + txid (12B)
    header = struct.pack(">HHI", MSG_ALLOCATE_REQUEST, 0, MAGIC_COOKIE) + transaction_id
    return header


def parse_response(data: bytes) -> tuple[int, int | None, str]:
    """Parse a STUN response.

    Returns
    -------
    msg_type : int
        Raw STUN message type.
    error_code : int | None
        Parsed error code if present, else None.
    description : str
        Human-readable summary.
    """
    if len(data) < 20:
        return -1, None, f"Response too short ({len(data)} bytes)"

    msg_type, msg_len, magic = struct.unpack_from(">HHI", data, 0)

    if magic != MAGIC_COOKIE:
        return msg_type, None, f"Unexpected magic cookie: 0x{magic:08X}"

    if msg_type == MSG_ALLOCATE_SUCCESS:
        return msg_type, None, "Allocate SUCCESS — TURN server accepted the request (no auth required?)"

    if msg_type == MSG_ALLOCATE_ERROR:
        # Scan attributes for ERROR-CODE (type 0x0009)
        offset = 20
        while offset + 4 <= 20 + msg_len:
            attr_type, attr_len = struct.unpack_from(">HH", data, offset)
            attr_val = data[offset + 4 : offset + 4 + attr_len]
            if attr_type == 0x0009 and len(attr_val) >= 4:
                # ERROR-CODE attribute: 2 reserved bytes, class (1B), number (1B), reason (rest)
                cls    = attr_val[2] & 0x07
                num    = attr_val[3]
                code   = cls * 100 + num
                reason = attr_val[4:].decode("utf-8", errors="replace").strip()
                return msg_type, code, f"Allocate ERROR {code}: {reason}"
            # Attributes are padded to 4-byte boundaries
            offset += 4 + attr_len + (4 - attr_len % 4) % 4
        return msg_type, None, "Allocate ERROR (could not parse error code)"

    return msg_type, None, f"Unexpected message type: 0x{msg_type:04X}"


def test_turn(host: str, port: int, *, use_tls: bool, timeout: float) -> bool:
    """Connect to the TURN/TURNS server, send an Allocate, and evaluate the response.

    Returns True if the server is reachable and behaving correctly.
    """
    proto = "TURNS (TLS)" if use_tls else "TURN"
    logger.info(f"Testing {proto} at {host}:{port} ...")

    raw_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raw_sock.settimeout(timeout)

    try:
        t0 = time.monotonic()
        raw_sock.connect((host, port))
        rtt_connect = (time.monotonic() - t0) * 1000

        if use_tls:
            ctx = ssl.create_default_context()
            # Allow self-signed certs in dev; warn the user
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            logger.warning("TLS certificate verification is DISABLED — suitable for dev/self-signed only")
            sock: socket.socket = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock

        logger.debug(f"Connected in {rtt_connect:.1f} ms")

        request = build_allocate_request()
        sock.sendall(request)

        # Read enough for a typical error response (header + a few attributes)
        response = sock.recv(4096)
        rtt_total = (time.monotonic() - t0) * 1000
        logger.debug(f"Got {len(response)} bytes in {rtt_total:.1f} ms total")

        msg_type, error_code, description = parse_response(response)
        logger.info(f"Response: {description}")

        # 401 = server is alive and requires auth (correct behaviour)
        # 403 = server refuses allocation but is still reachable
        # success = server allocated without auth (also fine for our purposes)
        if msg_type == MSG_ALLOCATE_SUCCESS:
            logger.success(f"{proto} server is REACHABLE and allocated without credentials.")
            return True
        elif msg_type == MSG_ALLOCATE_ERROR and error_code in (ERR_UNAUTHORIZED, ERR_FORBIDDEN):
            logger.success(
                f"{proto} server is REACHABLE and responding correctly "
                f"(error {error_code} = server is alive and asking for credentials)."
            )
            return True
        else:
            logger.error(f"{proto} server responded but with an unexpected result: {description}")
            return False

    except ssl.SSLError as e:
        logger.error(f"TLS handshake failed: {e}")
        logger.info("Check that the server cert is valid, or that you're not pointing at a plain TURN port.")
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
    "--turn-server",  "protocol", flag_value="turn",
    help="Test plain TURN (TCP, no TLS).",
)
@click.option(
    "--turns-server", "protocol", flag_value="turns", default=True,
    help="Test TURNS — TURN over TLS (default).",
)
@click.option(
    "--timeout", default=5.0, show_default=True,
    help="Socket timeout in seconds.",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging.")
def main(host: str, port: int, protocol: str, timeout: float, verbose: bool) -> None:
    """Check whether a TURN or TURNS server is reachable and responding.

    \b
    Examples:
        uv run check_turn.py --turns-server myrelay.example.com 5349
        uv run check_turn.py --turn-server  myrelay.example.com 3478
    """
    level = "DEBUG" if verbose else "INFO"
    logger.remove()
    logger.add(sys.stderr, level=level, colorize=True, format="<level>{level:<8}</level> {message}")

    use_tls = (protocol == "turns")
    ok = test_turn(host=host, port=port, use_tls=use_tls, timeout=timeout)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
