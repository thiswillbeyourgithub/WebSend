#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "click",
#   "loguru",
# ]
# ///
"""
check_turn.py: Test reachability of a TURN or TURNS (TURN over TLS) server.

Without --secret, sends an unauthenticated STUN Allocate request over TCP
(plain or TLS). A 401 Unauthorized response still means the server is up
and responding correctly: it just wants credentials.

With --secret, performs a full coturn REST-style authenticated Allocate
(static-auth-secret, RFC 7635). A 200 Allocate Success with a relayed
address proves the relay actually works end-to-end.

Usage:
    uv run check_turn.py --turn-server  <host> <port>
    uv run check_turn.py --turns-server <host> <port>
    uv run check_turn.py --turns-server <host> <port> --secret <static-auth-secret>
"""

import base64
import hashlib
import hmac
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
MSG_ALLOCATE_REQUEST  = 0x0003
MSG_ALLOCATE_SUCCESS  = 0x0103
MSG_ALLOCATE_ERROR    = 0x0113

# STUN attribute types
ATTR_USERNAME            = 0x0006
ATTR_MESSAGE_INTEGRITY   = 0x0008
ATTR_ERROR_CODE          = 0x0009
ATTR_LIFETIME            = 0x000D
ATTR_REALM               = 0x0014
ATTR_NONCE               = 0x0015
ATTR_XOR_RELAYED_ADDRESS = 0x0016
ATTR_REQUESTED_TRANSPORT = 0x0019
ATTR_XOR_MAPPED_ADDRESS  = 0x0020

# STUN error codes we care about
ERR_UNAUTHORIZED = 401
ERR_FORBIDDEN    = 403

# TURN transport protocols (RFC 5766)
TRANSPORT_UDP = 17

# Default lifetime requested for the test allocation, in seconds
DEFAULT_LIFETIME = 600

# Default validity window for the generated REST credential, in seconds
DEFAULT_CRED_TTL = 3600


def _pad4(b: bytes) -> bytes:
    pad = (4 - len(b) % 4) % 4
    return b + b"\x00" * pad


def _attr(attr_type: int, value: bytes) -> bytes:
    """Encode one STUN attribute (TLV, padded to a 4-byte boundary)."""
    return struct.pack(">HH", attr_type, len(value)) + _pad4(value)


def _parse_attributes(data: bytes) -> dict[int, bytes]:
    """Parse all STUN attributes from a full message into a {type: raw_value} dict."""
    attrs: dict[int, bytes] = {}
    if len(data) < 20:
        return attrs
    msg_len = struct.unpack_from(">H", data, 2)[0]
    offset = 20
    end = 20 + msg_len
    while offset + 4 <= end and offset + 4 <= len(data):
        attr_type, attr_len = struct.unpack_from(">HH", data, offset)
        val_start = offset + 4
        val_end = val_start + attr_len
        if val_end > len(data):
            break
        attrs[attr_type] = data[val_start:val_end]
        offset = val_end + ((4 - attr_len % 4) % 4)
    return attrs


def _parse_error_code(val: bytes) -> tuple[int | None, str]:
    if len(val) < 4:
        return None, ""
    cls = val[2] & 0x07
    num = val[3]
    code = cls * 100 + num
    reason = val[4:].decode("utf-8", errors="replace").strip()
    return code, reason


def _parse_xor_address(val: bytes, txid: bytes) -> str:
    """Decode an XOR-MAPPED-ADDRESS or XOR-RELAYED-ADDRESS value into 'ip:port'."""
    if len(val) < 8:
        return "<malformed>"
    family = val[1]
    xport = struct.unpack_from(">H", val, 2)[0]
    port = xport ^ (MAGIC_COOKIE >> 16)
    if family == 0x01:
        xaddr = val[4:8]
        magic = struct.pack(">I", MAGIC_COOKIE)
        addr = bytes(a ^ b for a, b in zip(xaddr, magic))
        return f"{addr[0]}.{addr[1]}.{addr[2]}.{addr[3]}:{port}"
    if family == 0x02:
        xaddr = val[4:20]
        mask = struct.pack(">I", MAGIC_COOKIE) + txid
        addr = bytes(a ^ b for a, b in zip(xaddr, mask))
        groups = [f"{addr[i]:02x}{addr[i+1]:02x}" for i in range(0, 16, 2)]
        return f"[{':'.join(groups)}]:{port}"
    return f"<unknown family 0x{family:02X}>"


def build_allocate_request(txid: bytes, *, with_requested_transport: bool = False) -> bytes:
    """Build a minimal Allocate request used to probe the server."""
    body = b""
    if with_requested_transport:
        body += _attr(ATTR_REQUESTED_TRANSPORT, struct.pack(">BBBB", TRANSPORT_UDP, 0, 0, 0))
    header = struct.pack(">HHI", MSG_ALLOCATE_REQUEST, len(body), MAGIC_COOKIE) + txid
    return header + body


def build_authenticated_allocate(
    txid: bytes,
    *,
    username: str,
    realm: str,
    nonce: bytes,
    password: str,
    lifetime: int = DEFAULT_LIFETIME,
) -> bytes:
    """Build an Allocate request with long-term credential MESSAGE-INTEGRITY."""
    body  = _attr(ATTR_REQUESTED_TRANSPORT, struct.pack(">BBBB", TRANSPORT_UDP, 0, 0, 0))
    body += _attr(ATTR_LIFETIME, struct.pack(">I", lifetime))
    body += _attr(ATTR_USERNAME, username.encode("utf-8"))
    body += _attr(ATTR_REALM, realm.encode("utf-8"))
    body += _attr(ATTR_NONCE, nonce)

    # Length in the STUN header must include the MESSAGE-INTEGRITY attribute (4 + 20 = 24 bytes),
    # but the HMAC itself is computed over the message up to (not including) that attribute.
    msg_len = len(body) + 24
    header = struct.pack(">HHI", MSG_ALLOCATE_REQUEST, msg_len, MAGIC_COOKIE) + txid

    key = hashlib.md5(f"{username}:{realm}:{password}".encode("utf-8")).digest()
    integrity = hmac.new(key, header + body, hashlib.sha1).digest()
    body += _attr(ATTR_MESSAGE_INTEGRITY, integrity)
    return header + body


def coturn_rest_credentials(secret: str, ttl: int = DEFAULT_CRED_TTL) -> tuple[str, str]:
    """Generate (username, password) for coturn's static-auth-secret REST mode.

    Username is an expiry epoch timestamp; password is base64(HMAC-SHA1(secret, username)).
    """
    expiry = int(time.time()) + ttl
    username = str(expiry)
    digest = hmac.new(secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    password = base64.b64encode(digest).decode("ascii")
    return username, password


def recv_stun_message(sock: socket.socket) -> bytes:
    """Read exactly one STUN message (header + length-prefixed body) from a TCP socket."""
    header = b""
    while len(header) < 20:
        chunk = sock.recv(20 - len(header))
        if not chunk:
            raise ConnectionError("Connection closed before full STUN header arrived")
        header += chunk
    msg_len = struct.unpack_from(">H", header, 2)[0]
    body = b""
    while len(body) < msg_len:
        chunk = sock.recv(msg_len - len(body))
        if not chunk:
            raise ConnectionError("Connection closed mid-STUN-body")
        body += chunk
    return header + body


def describe_response(data: bytes, txid: bytes) -> tuple[int, int | None, str, dict[int, bytes]]:
    """Return (msg_type, error_code, description, parsed_attrs)."""
    if len(data) < 20:
        return -1, None, f"Response too short ({len(data)} bytes)", {}
    msg_type = struct.unpack_from(">H", data, 0)[0]
    magic = struct.unpack_from(">I", data, 4)[0]
    if magic != MAGIC_COOKIE:
        return msg_type, None, f"Unexpected magic cookie: 0x{magic:08X}", {}

    attrs = _parse_attributes(data)

    if msg_type == MSG_ALLOCATE_SUCCESS:
        parts = ["Allocate SUCCESS"]
        if (relayed := attrs.get(ATTR_XOR_RELAYED_ADDRESS)) is not None:
            parts.append(f"relayed={_parse_xor_address(relayed, txid)}")
        if (mapped := attrs.get(ATTR_XOR_MAPPED_ADDRESS)) is not None:
            parts.append(f"reflexive={_parse_xor_address(mapped, txid)}")
        return msg_type, None, ", ".join(parts), attrs

    if msg_type == MSG_ALLOCATE_ERROR:
        ec = attrs.get(ATTR_ERROR_CODE)
        if ec is None:
            return msg_type, None, "Allocate ERROR (no ERROR-CODE attribute)", attrs
        code, reason = _parse_error_code(ec)
        return msg_type, code, f"Allocate ERROR {code}: {reason}", attrs

    return msg_type, None, f"Unexpected message type: 0x{msg_type:04X}", attrs


def _connect(host: str, port: int, *, use_tls: bool, timeout: float) -> tuple[socket.socket, socket.socket, float]:
    """Open a TCP (optionally TLS) connection. Returns (wrapped_sock, raw_sock, connect_ms)."""
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
            logger.warning("TLS certificate verification is DISABLED, suitable for dev/self-signed only")
            sock: socket.socket = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock
        return sock, raw_sock, rtt_connect
    except Exception:
        raw_sock.close()
        raise


def test_turn(
    host: str,
    port: int,
    *,
    use_tls: bool,
    timeout: float,
    secret: str | None,
    cred_ttl: int,
) -> bool:
    """Probe the TURN/TURNS server. With a secret, performs a full authenticated Allocate."""
    proto = "TURNS (TLS)" if use_tls else "TURN"
    mode  = "authenticated Allocate" if secret else "unauthenticated probe"
    logger.info(f"Testing {proto} at {host}:{port} ({mode}) ...")

    raw_sock = None
    try:
        sock, raw_sock, rtt_connect = _connect(host, port, use_tls=use_tls, timeout=timeout)
        logger.debug(f"Connected in {rtt_connect:.1f} ms")

        # Step 1: unauthenticated Allocate to either confirm reachability or pick up the 401 challenge.
        txid1 = os.urandom(12)
        sock.sendall(build_allocate_request(txid1, with_requested_transport=bool(secret)))
        t1 = time.monotonic()
        response = recv_stun_message(sock)
        logger.debug(f"First response: {len(response)} bytes in {(time.monotonic() - t1) * 1000:.1f} ms")

        msg_type, error_code, description, attrs = describe_response(response, txid1)
        logger.info(f"Probe response: {description}")

        if secret is None:
            if msg_type == MSG_ALLOCATE_SUCCESS:
                logger.success(f"{proto} server is REACHABLE and allocated without credentials.")
                return True
            if msg_type == MSG_ALLOCATE_ERROR and error_code in (ERR_UNAUTHORIZED, ERR_FORBIDDEN):
                logger.success(
                    f"{proto} server is REACHABLE and responding correctly "
                    f"(error {error_code} means the server is alive and asking for credentials)."
                )
                return True
            logger.error(f"{proto} server responded but with an unexpected result: {description}")
            return False

        # With a secret, we require a proper 401 challenge so we can authenticate.
        if msg_type != MSG_ALLOCATE_ERROR or error_code != ERR_UNAUTHORIZED:
            logger.error(
                f"Expected a 401 challenge from the server, got: {description}. "
                f"Cannot perform an authenticated Allocate."
            )
            return False

        realm_bytes = attrs.get(ATTR_REALM)
        nonce_bytes = attrs.get(ATTR_NONCE)
        if realm_bytes is None or nonce_bytes is None:
            logger.error("Server sent 401 but omitted REALM and/or NONCE, cannot authenticate.")
            return False
        realm = realm_bytes.decode("utf-8", errors="replace")
        logger.debug(f"Challenge: realm={realm!r} nonce={nonce_bytes.hex()}")

        username, password = coturn_rest_credentials(secret, ttl=cred_ttl)
        logger.debug(f"Derived REST credentials: username={username} password={password}")

        # Step 2: send the authenticated Allocate using the long-term credential mechanism.
        txid2 = os.urandom(12)
        auth_req = build_authenticated_allocate(
            txid2,
            username=username,
            realm=realm,
            nonce=nonce_bytes,
            password=password,
        )
        sock.sendall(auth_req)
        t2 = time.monotonic()
        response2 = recv_stun_message(sock)
        logger.debug(f"Auth response: {len(response2)} bytes in {(time.monotonic() - t2) * 1000:.1f} ms")

        msg_type2, error_code2, description2, attrs2 = describe_response(response2, txid2)
        logger.info(f"Auth response: {description2}")

        if msg_type2 == MSG_ALLOCATE_SUCCESS and ATTR_XOR_RELAYED_ADDRESS in attrs2:
            relayed = _parse_xor_address(attrs2[ATTR_XOR_RELAYED_ADDRESS], txid2)
            logger.success(
                f"{proto} server is FULLY FUNCTIONAL: authenticated Allocate succeeded, "
                f"relayed address = {relayed}."
            )
            return True

        if msg_type2 == MSG_ALLOCATE_SUCCESS:
            logger.warning("Allocate succeeded but no XOR-RELAYED-ADDRESS in response (unusual).")
            return True

        logger.error(
            f"Authenticated Allocate failed: {description2}. "
            f"Check that the secret matches coturn's static-auth-secret."
        )
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
    except ConnectionError as e:
        logger.error(f"Connection error: {e}")
        return False
    except OSError as e:
        logger.error(f"Network error: {e}")
        return False
    finally:
        if raw_sock is not None:
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
    help="Test TURNS, TURN over TLS (default).",
)
@click.option(
    "--secret",
    default=None,
    help=(
        "coturn static-auth-secret. When provided, performs a full authenticated "
        "Allocate using REST-style time-limited credentials (RFC 7635)."
    ),
)
@click.option(
    "--cred-ttl",
    type=int,
    default=DEFAULT_CRED_TTL,
    show_default=True,
    help="Validity window of the generated REST credential, in seconds.",
)
@click.option(
    "--timeout", default=5.0, show_default=True,
    help="Socket timeout in seconds.",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging.")
def main(
    host: str,
    port: int,
    protocol: str,
    secret: str | None,
    cred_ttl: int,
    timeout: float,
    verbose: bool,
) -> None:
    """Check whether a TURN or TURNS server is reachable and responding.

    \b
    Examples:
        uv run check_turn.py --turns-server myrelay.example.com 5349
        uv run check_turn.py --turn-server  myrelay.example.com 3478
        uv run check_turn.py --turns-server myrelay.example.com 5349 --secret s3cr3t
    """
    level = "DEBUG" if verbose else "INFO"
    logger.remove()
    logger.add(sys.stderr, level=level, colorize=True, format="<level>{level:<8}</level> {message}")

    use_tls = (protocol == "turns")
    ok = test_turn(
        host=host,
        port=port,
        use_tls=use_tls,
        timeout=timeout,
        secret=secret,
        cred_ttl=cred_ttl,
    )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
