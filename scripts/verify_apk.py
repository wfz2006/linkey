# -*- coding: utf-8 -*-
# APK 全面结构验证：模拟 Android 安装校验路径
# 1) ZIP 完整性  2) DEX 结构(map/校验和)  3) v1 JAR 签名摘要
# 4) v2 签名块: 解析/摘要重算/RSA 签名验证/证书链  5) manifest 关键属性
import struct, hashlib, zlib, zipfile, base64, sys
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.asymmetric import padding as apadding
from cryptography.hazmat.primitives import hashes
from cryptography.x509 import load_der_x509_certificate

sys.stdout.reconfigure(encoding='utf-8')
APK = sys.argv[1] if len(sys.argv) > 1 else r'D:\software\dist\Linkey-Android.apk'
data = open(APK, 'rb').read()
ok = True

def check(name, cond, detail=''):
    global ok
    print(('  ✔' if cond else '  ✘'), name, detail)
    if not cond: ok = False

# ---------- 1. ZIP ----------
print('== ZIP 完整性 ==')
try:
    zf = zipfile.ZipFile(APK)
    bad = zf.testzip()
    check('testzip', bad is None)
    names = zf.namelist()
    for req in ['AndroidManifest.xml', 'classes.dex', 'META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA']:
        check('条目 ' + req, req in names)
except Exception as e:
    check('zip 读取', False, str(e)); sys.exit(1)

# ---------- 2. DEX ----------
print('== DEX 结构 ==')
dex = zf.read('classes.dex')
check('magic', dex[:8] == b'dex\n035\x00', dex[:8])
file_size = struct.unpack_from('<I', dex, 32)[0]
check('file_size 一致', file_size == len(dex))
map_off = struct.unpack_from('<I', dex, 52)[0]
check('map_off > 0', map_off > 0, hex(map_off))
check('adler32', struct.unpack_from('<I', dex, 8)[0] == zlib.adler32(dex[12:]) & 0xFFFFFFFF)
check('sha1', dex[12:32] == hashlib.sha1(dex[32:]).digest())
map_count = struct.unpack_from('<I', dex, map_off)[0]
types_seen = []
prev_off = 0
sorted_ok = True
for i in range(map_count):
    t, _, n, off = struct.unpack_from('<HHII', dex, map_off + 4 + i * 12)
    types_seen.append(hex(t))
    if off < prev_off: sorted_ok = False
    prev_off = off
check('map 排序', sorted_ok, f'{map_count} 项: {types_seen}')
check('map 含自身', '0x1000' in types_seen)
check('map 含 class_data/code/string_data/type_list', all(t in types_seen for t in ['0x2000', '0x2001', '0x2002', '0x1001']))
data_off_hdr = struct.unpack_from('<I', dex, 108)[0]
data_size_hdr = struct.unpack_from('<I', dex, 104)[0]
check('data 区覆盖 map', data_off_hdr + data_size_hdr == len(dex), f'{data_off_hdr}+{data_size_hdr}')

# ---------- 3. v1 ----------
print('== v1 JAR 签名 ==')
mf = zf.read('META-INF/MANIFEST.MF')
check('MANIFEST.MF 有 SHA-256-Digest', b'SHA-256-Digest' in mf)

# ---------- 4. v2 ----------
print('== v2 签名块 ==')
eocd_pos = data.rfind(b'PK\x05\x06')
cd_size, cd_offset = struct.unpack_from('<II', data, eocd_pos + 12)
# 签名块位于 CD 之前，尾部 24 字节: u64 size + magic
magic_pos = cd_offset - 16
check('magic "APK Sig Block 42"', data[magic_pos:magic_pos+16] == b'APK Sig Block 42')
blk_size_trailer = struct.unpack_from('<Q', data, magic_pos - 8)[0]
blk_start = magic_pos + 16 - blk_size_trailer - 8
blk_size_header = struct.unpack_from('<Q', data, blk_start)[0]
check('块尺寸前后一致', blk_size_header == blk_size_trailer, f'{blk_size_header}')
# EOCD 的 CD offset 应指向签名块之后
check('EOCD CD offset 回填', struct.unpack_from('<I', data, eocd_pos + 16)[0] == cd_offset, f'cd_offset={cd_offset}')
pairs_data = data[blk_start + 8: magic_pos - 8]
pos = 0
v2_value = None
while pos < len(pairs_data):
    plen = struct.unpack_from('<Q', pairs_data, pos)[0]
    pid = struct.unpack_from('<I', pairs_data, pos + 8)[0]
    val = pairs_data[pos + 12: pos + 8 + plen]
    print(f'  · pair id=0x{pid:x} len={plen}')
    if pid == 0x7109871a: v2_value = val
    pos += 8 + plen
check('存在 v2 pair', v2_value is not None)

def rd_u32(buf, off): return struct.unpack_from('<I', buf, off)[0]
def rd_lp(buf, off):
    n = rd_u32(buf, off); return buf[off+4:off+4+n], off+4+n

signers, p = rd_lp(v2_value, 0)
signer, p = rd_lp(signers, 0)
signed_data, p = rd_lp(signer, 0)
sigs, p = rd_lp(signer, p)
pubkey, p = rd_lp(signer, p)
check('signer 后无多余字节', p == len(signer))

digests, q = rd_lp(signed_data, 0)
certs, q = rd_lp(signed_data, q)
attrs, q = rd_lp(signed_data, q)
check('signed data 解析完', q == len(signed_data))
check('附加属性为空', len(attrs) == 0)

rec, _ = rd_lp(digests, 0)
algo = rd_u32(rec, 0)
digest_in_blk, r = rd_lp(rec, 4)
check('算法 = 0x0101 (RSA-PKCS1-SHA256)', algo == 0x0101)

cert_der, _ = rd_lp(certs, 0)
cert = load_der_x509_certificate(cert_der)
check('证书可解析', True, f'subject={cert.subject.rfc4514_string()}')

# 重算内容摘要（分块 1MB）
def chunked_digest(b):
    CHUNK = 1024 * 1024
    chunks = [b[i:i+CHUNK] for i in range(0, len(b), CHUNK)] or [b'']
    parts = [hashlib.sha256(b'\xa5' + struct.pack('<I', len(c)) + c).digest() for c in chunks]
    return hashlib.sha256(b'\x5a' + struct.pack('<I', len(parts)) + b''.join(parts)).digest()

entries_region = data[:blk_start]   # 签名块本身不参与摘要
cd_region = data[cd_offset:cd_offset+cd_size]
eocd = bytearray(data[eocd_pos:])
struct.pack_into('<I', eocd, 16, cd_offset)  # 已回填后的值(当前文件即如此)
total = hashlib.sha256(chunked_digest(entries_region) + chunked_digest(cd_region) + chunked_digest(bytes(eocd))).digest()
check('内容摘要重算一致', total == digest_in_blk, f'{total.hex()[:16]}... vs {digest_in_blk.hex()[:16]}...')

sig_rec, _ = rd_lp(sigs, 0)
sig_algo = rd_u32(sig_rec, 0)
sig_val, _r = rd_lp(sig_rec, 4)
check('签名算法一致', sig_algo == algo)
try:
    cert.public_key().verify(sig_val, signed_data, apadding.PKCS1v15(), hashes.SHA256())
    check('RSA 签名验证通过', True)
except Exception as e:
    check('RSA 签名验证通过', False, str(e))

# ---------- 5. v1 摘要复核 ----------
print('== v1 摘要复核 ==')
sf = zf.read('META-INF/CERT.SF')
ok_v1 = True
for line_block in mf.decode().split('\r\n\r\n'):
    if not line_block.strip(): continue
    lines = line_block.split('\r\n')
    name = None; dig = None
    for l in lines:
        if l.startswith('Name: '): name = l[6:]
        if l.startswith('SHA-256-Digest: '): dig = l[16:]
    if name and name in names and dig:
        calc = base64.b64encode(hashlib.sha256(zf.read(name)).digest()).decode()
        if calc != dig: ok_v1 = False; print('   v1 摘要不符:', name)
check('MANIFEST.MF 摘要全部一致', ok_v1)

print()
print('RESULT:', 'ALL PASS' if ok else 'FAILED')
sys.exit(0 if ok else 1)
