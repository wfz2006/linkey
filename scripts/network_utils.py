"""Network address selection shared by Linkey build and packaging scripts."""

import ipaddress
import os
import socket


_BENCHMARK_NETWORK = ipaddress.ip_network('198.18.0.0/15')


def select_lan_ip(candidates):
    """Choose a likely device-reachable RFC1918 address from candidate IPv4 strings."""
    ranked = []
    seen = set()

    for index, raw in enumerate(candidates or []):
        value = str(raw or '').strip()
        if not value or value in seen:
            continue
        seen.add(value)

        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            continue

        if (
            address.version != 4
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_unspecified
            or address in _BENCHMARK_NETWORK
        ):
            continue

        if address in ipaddress.ip_network('192.168.0.0/16'):
            score = 300
        elif address in ipaddress.ip_network('10.0.0.0/8'):
            score = 200
        elif address in ipaddress.ip_network('172.16.0.0/12'):
            score = 100
        else:
            continue

        ranked.append((score, -index, value))

    return max(ranked)[2] if ranked else None


def get_lan_ip(candidates=None):
    """Return the LAN host used by generated clients, with an explicit env override."""
    override = os.environ.get('LINKEY_SERVER_HOST', '').strip()
    if not override:
        override = os.environ.get('FASTQQ_SERVER_HOST', '').strip()
    if override:
        return override

    detected = list(candidates or [])
    if candidates is None:
        try:
            detected.extend(
                item[4][0]
                for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
            )
        except OSError:
            pass

        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(('10.255.255.255', 1))
            detected.append(probe.getsockname()[0])
        except OSError:
            pass
        finally:
            probe.close()

    return select_lan_ip(detected) or '127.0.0.1'
