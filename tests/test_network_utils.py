import os
import unittest
from unittest import mock

from scripts.network_utils import get_lan_ip, select_lan_ip


class LanIpSelectionTests(unittest.TestCase):
    def test_prefers_real_home_lan_over_tun_and_wsl_addresses(self):
        candidates = ['198.18.0.1', '172.26.176.1', '192.168.1.5']
        self.assertEqual(select_lan_ip(candidates), '192.168.1.5')

    def test_ignores_loopback_link_local_and_benchmark_ranges(self):
        candidates = ['127.0.0.1', '169.254.20.1', '198.18.0.1', '10.0.0.23']
        self.assertEqual(select_lan_ip(candidates), '10.0.0.23')

    def test_environment_override_wins(self):
        with mock.patch.dict(os.environ, {'FASTQQ_SERVER_HOST': '192.168.50.9'}):
            self.assertEqual(get_lan_ip(['192.168.1.5']), '192.168.50.9')


if __name__ == '__main__':
    unittest.main()
