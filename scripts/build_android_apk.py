import os
import sys
import struct
import io
import zlib
import hashlib
import zipfile
import datetime
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography import x509
from cryptography.x509.oid import NameOID

from network_utils import get_lan_ip

# ==============================================================================
# 1. ANDROID BINARY XML (AXML) ENCODER
# ==============================================================================
RES_XML_TYPE = 0x0003
RES_STRING_POOL_TYPE = 0x0001
RES_XML_RESOURCE_MAP_TYPE = 0x0180
RES_XML_START_NAMESPACE_TYPE = 0x0100
RES_XML_END_NAMESPACE_TYPE = 0x0101
RES_XML_START_ELEMENT_TYPE = 0x0102
RES_XML_END_ELEMENT_TYPE = 0x0103

TYPE_NULL = 0x00
TYPE_REFERENCE = 0x01
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10
TYPE_INT_BOOLEAN = 0x12

class StringPoolBuilder:
    def __init__(self):
        self.strings = []
        self.str_map = {}

    def add(self, s):
        if s not in self.str_map:
            idx = len(self.strings)
            self.strings.append(s)
            self.str_map[s] = idx
            return idx
        return self.str_map[s]

    def build_utf8(self):
        encoded_strs = []
        for s in self.strings:
            utf8 = s.encode('utf-8')
            char_len = len(s)
            byte_len = len(utf8)
            # Encode UTF-8 lengths
            data = bytearray()
            if char_len <= 127:
                data.append(char_len)
            else:
                data.extend([0x80 | ((char_len >> 8) & 0x7F), char_len & 0xFF])
            if byte_len <= 127:
                data.append(byte_len)
            else:
                data.extend([0x80 | ((byte_len >> 8) & 0x7F), byte_len & 0xFF])
            data.extend(utf8)
            data.append(0x00) # null terminator
            encoded_strs.append(bytes(data))

        # Offsets
        offsets = []
        current_offset = 0
        for b in encoded_strs:
            offsets.append(current_offset)
            current_offset += len(b)

        # Pad string data to 4-byte boundary
        str_data = b''.join(encoded_strs)
        padding_len = (4 - (len(str_data) % 4)) % 4
        str_data += b'\x00' * padding_len

        header_size = 28
        strings_start = header_size + len(offsets) * 4
        total_size = strings_start + len(str_data)

        # Build chunk
        header = struct.pack(
            '<HHIIIIII',
            RES_STRING_POOL_TYPE,
            header_size,
            total_size,
            len(self.strings),
            0, # styleCount
            1 << 8, # UTF-8 flag
            strings_start,
            0 # stylesStart
        )
        offsets_data = b''.join(struct.pack('<I', off) for off in offsets)
        return header + offsets_data + str_data

def build_binary_manifest(package_name="com.fastqq.app", version_code=1, version_name="4.2.0", app_label="Linkey", server_url="http://192.168.1.8:3000"):
    sp = StringPoolBuilder()

    # Pre-populate strings
    s_ns_android = sp.add("http://schemas.android.com/apk/res/android")
    s_prefix_android = sp.add("android")
    
    # Tags
    s_manifest = sp.add("manifest")
    s_uses_sdk = sp.add("uses-sdk")
    s_uses_permission = sp.add("uses-permission")
    s_application = sp.add("application")
    s_activity = sp.add("activity")
    s_intent_filter = sp.add("intent-filter")
    s_action = sp.add("action")
    s_category = sp.add("category")
    s_meta_data = sp.add("meta-data")

    # Attributes
    s_package = sp.add("package")
    s_versionCode = sp.add("versionCode")
    s_versionName = sp.add("versionName")
    s_minSdkVersion = sp.add("minSdkVersion")
    s_targetSdkVersion = sp.add("targetSdkVersion")
    s_name = sp.add("name")
    s_label = sp.add("label")
    s_icon = sp.add("icon")
    s_exported = sp.add("exported")
    s_theme = sp.add("theme")
    s_hardwareAccelerated = sp.add("hardwareAccelerated")
    s_usesCleartextTraffic = sp.add("usesCleartextTraffic")
    s_screenOrientation = sp.add("screenOrientation")
    s_value = sp.add("value")

    # Values
    s_val_pkg = sp.add(package_name)
    s_val_vname = sp.add(version_name)
    s_val_label = sp.add(app_label)
    s_val_act_name = sp.add(".MainActivity")
    s_val_action_main = sp.add("android.intent.action.MAIN")
    s_val_cat_launcher = sp.add("android.intent.category.LAUNCHER")
    s_val_perm_internet = sp.add("android.permission.INTERNET")
    s_val_perm_network = sp.add("android.permission.ACCESS_NETWORK_STATE")
    s_val_perm_wifi = sp.add("android.permission.ACCESS_WIFI_STATE")
    s_val_theme = sp.add("@android:style/Theme.NoTitleBar")
    s_val_server_url = sp.add(server_url)
    s_val_meta_server = sp.add("server_url")

    # Res IDs map for attributes
    res_map = [
        (s_theme, 0x01010000),
        (s_label, 0x01010001),
        (s_icon, 0x01010002),
        (s_name, 0x01010003),
        (s_exported, 0x01010010),
        (s_screenOrientation, 0x0101001e),
        (s_value, 0x01010024),
        (s_minSdkVersion, 0x0101020c),
        (s_versionCode, 0x0101021b),
        (s_versionName, 0x0101021c),
        (s_targetSdkVersion, 0x01010270),
        (s_hardwareAccelerated, 0x010102d3),
        (s_usesCleartextTraffic, 0x010104ec),
    ]
    res_map.sort(key=lambda x: x[0])

    # Nodes
    nodes = bytearray()

    def start_ns():
        return struct.pack('<HHIIIII', RES_XML_START_NAMESPACE_TYPE, 16, 24, 1, 0xFFFFFFFF, s_prefix_android, s_ns_android)

    def end_ns():
        return struct.pack('<HHIIIII', RES_XML_END_NAMESPACE_TYPE, 16, 24, 1, 0xFFFFFFFF, s_prefix_android, s_ns_android)

    def make_attr(ns_idx, name_idx, raw_idx, data_type, data_val):
        return struct.pack('<IIIBBHI', ns_idx, name_idx, raw_idx, 8, 0, data_type, data_val)

    def start_elem(name_idx, attrs):
        attr_bytes = b''.join(attrs)
        size = 36 + len(attr_bytes)
        hdr = struct.pack('<HHIIIIIHHHHHH',
            RES_XML_START_ELEMENT_TYPE, 16, size, 1, 0xFFFFFFFF, 0xFFFFFFFF, name_idx,
            20, 20, len(attrs), 0, 0, 0
        )
        return hdr + attr_bytes

    def end_elem(name_idx):
        return struct.pack('<HHIIIII', RES_XML_END_ELEMENT_TYPE, 16, 24, 1, 0xFFFFFFFF, 0xFFFFFFFF, name_idx)

    # 1. Start namespace
    nodes.extend(start_ns())

    # 2. <manifest package="..." android:versionCode="1" android:versionName="4.1.0">
    manifest_attrs = [
        make_attr(0xFFFFFFFF, s_package, s_val_pkg, TYPE_STRING, s_val_pkg),
        make_attr(s_ns_android, s_versionCode, 0xFFFFFFFF, TYPE_INT_DEC, version_code),
        make_attr(s_ns_android, s_versionName, s_val_vname, TYPE_STRING, s_val_vname),
    ]
    nodes.extend(start_elem(s_manifest, manifest_attrs))

    # 3. <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34"/>
    sdk_attrs = [
        make_attr(s_ns_android, s_minSdkVersion, 0xFFFFFFFF, TYPE_INT_DEC, 21),
        make_attr(s_ns_android, s_targetSdkVersion, 0xFFFFFFFF, TYPE_INT_DEC, 34),
    ]
    nodes.extend(start_elem(s_uses_sdk, sdk_attrs))
    nodes.extend(end_elem(s_uses_sdk))

    # 4. <uses-permission android:name="android.permission.INTERNET"/>
    perm1_attrs = [make_attr(s_ns_android, s_name, s_val_perm_internet, TYPE_STRING, s_val_perm_internet)]
    nodes.extend(start_elem(s_uses_permission, perm1_attrs))
    nodes.extend(end_elem(s_uses_permission))

    # <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
    perm2_attrs = [make_attr(s_ns_android, s_name, s_val_perm_network, TYPE_STRING, s_val_perm_network)]
    nodes.extend(start_elem(s_uses_permission, perm2_attrs))
    nodes.extend(end_elem(s_uses_permission))

    # <uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>
    perm3_attrs = [make_attr(s_ns_android, s_name, s_val_perm_wifi, TYPE_STRING, s_val_perm_wifi)]
    nodes.extend(start_elem(s_uses_permission, perm3_attrs))
    nodes.extend(end_elem(s_uses_permission))

    # 5. <application android:label="Linkey" android:theme="@android:style/Theme.NoTitleBar" android:hardwareAccelerated="true" android:usesCleartextTraffic="true">
    app_attrs = [
        make_attr(s_ns_android, s_label, s_val_label, TYPE_STRING, s_val_label),
        make_attr(s_ns_android, s_theme, s_val_theme, TYPE_STRING, s_val_theme),
        make_attr(s_ns_android, s_hardwareAccelerated, 0xFFFFFFFF, TYPE_INT_BOOLEAN, 1),
        make_attr(s_ns_android, s_usesCleartextTraffic, 0xFFFFFFFF, TYPE_INT_BOOLEAN, 1),
    ]
    nodes.extend(start_elem(s_application, app_attrs))

    # 6. <activity android:name=".MainActivity" android:label="Linkey" android:exported="true" android:screenOrientation="portrait">
    act_attrs = [
        make_attr(s_ns_android, s_name, s_val_act_name, TYPE_STRING, s_val_act_name),
        make_attr(s_ns_android, s_label, s_val_label, TYPE_STRING, s_val_label),
        make_attr(s_ns_android, s_exported, 0xFFFFFFFF, TYPE_INT_BOOLEAN, 1),
        make_attr(s_ns_android, s_screenOrientation, 0xFFFFFFFF, TYPE_INT_DEC, 1), # portrait
    ]
    nodes.extend(start_elem(s_activity, act_attrs))

    # 7. <intent-filter>
    nodes.extend(start_elem(s_intent_filter, []))
    # <action android:name="android.intent.action.MAIN"/>
    action_attrs = [make_attr(s_ns_android, s_name, s_val_action_main, TYPE_STRING, s_val_action_main)]
    nodes.extend(start_elem(s_action, action_attrs))
    nodes.extend(end_elem(s_action))
    # <category android:name="android.intent.category.LAUNCHER"/>
    cat_attrs = [make_attr(s_ns_android, s_name, s_val_cat_launcher, TYPE_STRING, s_val_cat_launcher)]
    nodes.extend(start_elem(s_category, cat_attrs))
    nodes.extend(end_elem(s_category))
    nodes.extend(end_elem(s_intent_filter))

    # <meta-data android:name="server_url" android:value="http://192.168.1.8:3000"/>
    meta_attrs = [
        make_attr(s_ns_android, s_name, s_val_meta_server, TYPE_STRING, s_val_meta_server),
        make_attr(s_ns_android, s_value, s_val_server_url, TYPE_STRING, s_val_server_url),
    ]
    nodes.extend(start_elem(s_meta_data, meta_attrs))
    nodes.extend(end_elem(s_meta_data))

    nodes.extend(end_elem(s_activity))
    nodes.extend(end_elem(s_application))
    nodes.extend(end_elem(s_manifest))

    # End namespace
    nodes.extend(end_ns())

    # Build String Pool & Resource Map
    str_pool = sp.build_utf8()
    
    # Resource Map
    # Map each string in string pool: if it's in res_map, put its ID, else 0
    res_ids = []
    res_dict = dict(res_map)
    for idx in range(len(sp.strings)):
        res_ids.append(res_dict.get(idx, 0))
    res_map_data = struct.pack('<HHI', RES_XML_RESOURCE_MAP_TYPE, 8, 8 + len(res_ids) * 4) + b''.join(struct.pack('<I', rid) for rid in res_ids)

    total_file_size = 8 + len(str_pool) + len(res_map_data) + len(nodes)
    header = struct.pack('<HHI', RES_XML_TYPE, 8, total_file_size)
    return header + str_pool + res_map_data + bytes(nodes)

# ==============================================================================
# 2. DALVIK EXECUTABLE (classes.dex) GENERATOR
# ==============================================================================
def make_leb128(val):
    out = bytearray()
    while True:
        b = val & 0x7F
        val >>= 7
        if val == 0:
            out.append(b)
            break
        else:
            out.append(b | 0x80)
    return bytes(out)

def create_valid_dex(server_url="http://192.168.1.8:3000"):
    # Generate complete DEX bytecode using pure python
    # Standard classes.dex for Android WebView App
    # We will assemble all tables: strings, types, protos, fields, methods, classes, code
    
    strings = [
        "",
        "<init>",
        "Landroid/app/Activity;",
        "Landroid/content/Context;",
        "Landroid/os/Bundle;",
        "Landroid/view/View;",
        "Landroid/webkit/WebSettings;",
        "Landroid/webkit/WebView;",
        "Landroid/webkit/WebViewClient;",
        "Lcom/fastqq/app/MainActivity;",
        "Ljava/lang/String;",
        "MainActivity.java",
        "L",
        "LL",
        "V",
        "VI",
        "VL",
        "VZ",
        "Z",
        "canGoBack",
        "getSettings",
        "goBack",
        "loadUrl",
        "onBackPressed",
        "onCreate",
        "setContentView",
        "setDatabaseEnabled",
        "setDomStorageEnabled",
        "setJavaScriptEnabled",
        "setWebViewClient",
        "webView",
        server_url
    ]
    strings = sorted(list(set(strings)))
    str_map = {s: i for i, s in enumerate(strings)}

    types = sorted([
        "Landroid/app/Activity;",
        "Landroid/content/Context;",
        "Landroid/os/Bundle;",
        "Landroid/view/View;",
        "Landroid/webkit/WebSettings;",
        "Landroid/webkit/WebView;",
        "Landroid/webkit/WebViewClient;",
        "Lcom/fastqq/app/MainActivity;",
        "Ljava/lang/String;",
        "V",
        "Z"
    ])
    type_map = {t: i for i, t in enumerate(types)}

    # Protos: (shorty_str, return_type_str, (param_type_strs,))
    protos = [
        ("V", "V", ()),
        ("V", "V", ("Landroid/content/Context;",)),
        ("V", "V", ("Landroid/os/Bundle;",)),
        ("V", "V", ("Landroid/view/View;",)),
        ("V", "V", ("Landroid/webkit/WebViewClient;",)),
        ("V", "V", ("Ljava/lang/String;",)),
        ("V", "V", ("Z",)),
        ("L", "Landroid/webkit/WebSettings;", ()),
        ("Z", "Z", ())
    ]
    proto_map = {p: i for i, p in enumerate(protos)}

    # Fields: (class_type, type, name_str)
    fields = [
        ("Lcom/fastqq/app/MainActivity;", "Landroid/webkit/WebView;", "webView")
    ]
    field_map = {f: i for i, f in enumerate(fields)}

    # Methods: (class_type, proto_tuple, name_str)
    methods = [
        ("Landroid/app/Activity;", ("V", "V", ()), "<init>"),
        ("Landroid/app/Activity;", ("V", "V", ()), "onBackPressed"),
        ("Landroid/app/Activity;", ("V", "V", ("Landroid/os/Bundle;",)), "onCreate"),
        ("Landroid/app/Activity;", ("V", "V", ("Landroid/view/View;",)), "setContentView"),
        ("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setDatabaseEnabled"),
        ("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setDomStorageEnabled"),
        ("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setJavaScriptEnabled"),
        ("Landroid/webkit/WebView;", ("V", "V", ("Landroid/content/Context;",)), "<init>"),
        ("Landroid/webkit/WebView;", ("Z", "Z", ()), "canGoBack"),
        ("Landroid/webkit/WebView;", ("L", "Landroid/webkit/WebSettings;", ()), "getSettings"),
        ("Landroid/webkit/WebView;", ("V", "V", ()), "goBack"),
        ("Landroid/webkit/WebView;", ("V", "V", ("Ljava/lang/String;",)), "loadUrl"),
        ("Landroid/webkit/WebView;", ("V", "V", ("Landroid/webkit/WebViewClient;",)), "setWebViewClient"),
        ("Landroid/webkit/WebViewClient;", ("V", "V", ()), "<init>"),
        ("Lcom/fastqq/app/MainActivity;", ("V", "V", ()), "<init>"),
        ("Lcom/fastqq/app/MainActivity;", ("V", "V", ()), "onBackPressed"),
        ("Lcom/fastqq/app/MainActivity;", ("V", "V", ("Landroid/os/Bundle;",)), "onCreate")
    ]
    methods = sorted(methods, key=lambda m: (type_map[m[0]], str_map[m[2]], proto_map[m[1]]))
    method_map = {m: i for i, m in enumerate(methods)}

    # Code items:
    # Code 1: MainActivity.<init>()V
    # registers: 1, in_words: 1, out_words: 1, insns:
    # 0x0000: invoke-direct {v0}, Landroid/app/Activity;-><init>()V
    # 0x0003: return-void
    m_act_init = method_map[("Landroid/app/Activity;", ("V", "V", ()), "<init>")]
    insns_init = struct.pack('<HHH', 0x1070 | (1 << 8), m_act_init, 0x0000) + struct.pack('<H', 0x000e)
    code_init = struct.pack('<HHHHIII', 1, 1, 1, 0, 0, len(insns_init) // 2, 0) + insns_init

    # Code 2: MainActivity.onBackPressed()V
    f_wv = field_map[("Lcom/fastqq/app/MainActivity;", "Landroid/webkit/WebView;", "webView")]
    m_can_go_back = method_map[("Landroid/webkit/WebView;", ("Z", "Z", ()), "canGoBack")]
    m_go_back = method_map[("Landroid/webkit/WebView;", ("V", "V", ()), "goBack")]
    m_super_back = method_map[("Landroid/app/Activity;", ("V", "V", ()), "onBackPressed")]

    insns_back = bytearray()
    insns_back.extend(struct.pack('<HH', 0x0154, f_wv))
    insns_back.extend(struct.pack('<Hh', 0x0038, 7))
    insns_back.extend(struct.pack('<HHH', 0x106e, m_can_go_back, 0x0000))
    insns_back.extend(struct.pack('<H', 0x000a))
    insns_back.extend(struct.pack('<Hh', 0x0038, 3))
    insns_back.extend(struct.pack('<HH', 0x0154, f_wv))
    insns_back.extend(struct.pack('<HHH', 0x106e, m_go_back, 0x0000))
    insns_back.extend(struct.pack('<H', 0x000e))
    insns_back.extend(struct.pack('<HHH', 0x106f, m_super_back, 0x0001))
    insns_back.extend(struct.pack('<H', 0x000e))

    code_back = struct.pack('<HHHHIII', 2, 1, 1, 0, 0, len(insns_back) // 2, 0) + bytes(insns_back)

    # Code 3: MainActivity.onCreate(Bundle)V
    m_super_create = method_map[("Landroid/app/Activity;", ("V", "V", ("Landroid/os/Bundle;",)), "onCreate")]
    t_wv = type_map["Landroid/webkit/WebView;"]
    m_wv_init = method_map[("Landroid/webkit/WebView;", ("V", "V", ("Landroid/content/Context;",)), "<init>")]
    m_set_content = method_map[("Landroid/app/Activity;", ("V", "V", ("Landroid/view/View;",)), "setContentView")]
    m_get_settings = method_map[("Landroid/webkit/WebView;", ("L", "Landroid/webkit/WebSettings;", ()), "getSettings")]
    m_set_js = method_map[("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setJavaScriptEnabled")]
    m_set_dom = method_map[("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setDomStorageEnabled")]
    m_set_db = method_map[("Landroid/webkit/WebSettings;", ("V", "V", ("Z",)), "setDatabaseEnabled")]
    t_wvc = type_map["Landroid/webkit/WebViewClient;"]
    m_wvc_init = method_map[("Landroid/webkit/WebViewClient;", ("V", "V", ()), "<init>")]
    m_set_wvc = method_map[("Landroid/webkit/WebView;", ("V", "V", ("Landroid/webkit/WebViewClient;",)), "setWebViewClient")]
    s_url_idx = str_map[server_url]
    m_load_url = method_map[("Landroid/webkit/WebView;", ("V", "V", ("Ljava/lang/String;",)), "loadUrl")]

    insns_create = bytearray()
    # 0: invoke-super {v2, v3}, Activity->onCreate
    insns_create.extend(struct.pack('<HHH', 0x206f, m_super_create, 0x0032))
    # 3: new-instance v0, WebView (0x22, v0, t_wv)
    insns_create.extend(struct.pack('<HH', 0x0022, t_wv))
    # 5: invoke-direct {v0, v2}, WebView-><init>(Context) (0x2070, m_wv_init, 0x0020)
    insns_create.extend(struct.pack('<HHH', 0x2070, m_wv_init, 0x0020))
    # 8: iput-object v0, v2, f_wv (0x5b, 0x025b, f_wv)
    insns_create.extend(struct.pack('<HH', 0x025b, f_wv))
    # 10: invoke-virtual {v2, v0}, Activity->setContentView (0x206e, m_set_content, 0x0002)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_set_content, 0x0002))
    # 13: iget-object v0, v2, f_wv
    insns_create.extend(struct.pack('<HH', 0x0254, f_wv))
    # 15: invoke-virtual {v0}, WebView->getSettings (0x106e, m_get_settings, 0x0000)
    insns_create.extend(struct.pack('<HHH', 0x106e, m_get_settings, 0x0000))
    # 18: move-result-object v1 (0x0c)
    insns_create.extend(struct.pack('<H', 0x010c))
    # 19: const/4 v0, 1 (0x12, 0x1012)
    insns_create.extend(struct.pack('<H', 0x1012))
    # 20: invoke-virtual {v1, v0}, WebSettings->setJavaScriptEnabled (0x206e, m_set_js, 0x0001)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_set_js, 0x0001))
    # 23: invoke-virtual {v1, v0}, WebSettings->setDomStorageEnabled (0x206e, m_set_dom, 0x0001)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_set_dom, 0x0001))
    # 26: invoke-virtual {v1, v0}, WebSettings->setDatabaseEnabled (0x206e, m_set_db, 0x0001)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_set_db, 0x0001))
    # 29: iget-object v0, v2, f_wv
    insns_create.extend(struct.pack('<HH', 0x0254, f_wv))
    # 31: new-instance v1, WebViewClient
    insns_create.extend(struct.pack('<HH', 0x0122, t_wvc))
    # 33: invoke-direct {v1}, WebViewClient-><init> (0x1070, m_wvc_init, 0x0001)
    insns_create.extend(struct.pack('<HHH', 0x1070, m_wvc_init, 0x0001))
    # 36: invoke-virtual {v0, v1}, WebView->setWebViewClient (0x206e, m_set_wvc, 0x0010)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_set_wvc, 0x0010))
    # 39: iget-object v0, v2, f_wv
    insns_create.extend(struct.pack('<HH', 0x0254, f_wv))
    # 41: const-string v1, server_url (0x1a, v1, s_url_idx)
    insns_create.extend(struct.pack('<HH', 0x011a, s_url_idx))
    # 43: invoke-virtual {v0, v1}, WebView->loadUrl (0x206e, m_load_url, 0x0010)
    insns_create.extend(struct.pack('<HHH', 0x206e, m_load_url, 0x0010))
    # 46: return-void
    insns_create.extend(struct.pack('<H', 0x000e))

    code_create = struct.pack('<HHHHIII', 4, 2, 2, 0, 0, len(insns_create) // 2, 0) + bytes(insns_create)

    # Assemble DEX sections
    # Data section contains: string data, type lists, code items, class data
    data_bytes = bytearray()

    # Align 4 helper
    def align4(buf):
        pad = (4 - (len(buf) % 4)) % 4
        buf.extend(b'\x00' * pad)

    # 1. Type lists for protos
    proto_type_list_offs = []
    for shorty, ret, params in protos:
        if not params:
            proto_type_list_offs.append(0)
        else:
            align4(data_bytes)
            off = len(data_bytes)
            proto_type_list_offs.append(off)
            data_bytes.extend(struct.pack('<I', len(params)))
            for p in params:
                data_bytes.extend(struct.pack('<H', type_map[p]))
            align4(data_bytes)

    # 2. String data
    str_data_item_offs = []
    for s in strings:
        str_data_item_offs.append(len(data_bytes))
        utf8 = s.encode('utf-8')
        data_bytes.extend(make_leb128(len(s)))
        data_bytes.extend(utf8)
        data_bytes.append(0x00)
    align4(data_bytes)

    # 3. Code items
    align4(data_bytes)
    code_init_off = len(data_bytes)
    data_bytes.extend(code_init)
    align4(data_bytes)

    code_back_off = len(data_bytes)
    data_bytes.extend(code_back)
    align4(data_bytes)

    code_create_off = len(data_bytes)
    data_bytes.extend(code_create)
    align4(data_bytes)

    # Now calculate header and fixed table offsets
    header_size = 112
    string_ids_off = header_size
    type_ids_off = string_ids_off + len(strings) * 4
    proto_ids_off = type_ids_off + len(types) * 4
    field_ids_off = proto_ids_off + len(protos) * 12
    method_ids_off = field_ids_off + len(fields) * 8
    class_defs_off = method_ids_off + len(methods) * 8
    data_off = class_defs_off + 1 * 32 # 1 class def

    # 4. Class data item for MainActivity:
    # static_fields_size: 0
    # instance_fields_size: 1 (field 0: ACC_PRIVATE 0x0002)
    # direct_methods_size: 1 (<init> ACC_PUBLIC|ACC_CONSTRUCTOR 0x10001)
    # virtual_methods_size: 2 (onBackPressed ACC_PUBLIC 0x0001, onCreate ACC_PROTECTED 0x0004)
    m_init_idx = method_map[("Lcom/fastqq/app/MainActivity;", ("V", "V", ()), "<init>")]
    m_back_idx = method_map[("Lcom/fastqq/app/MainActivity;", ("V", "V", ()), "onBackPressed")]
    m_create_idx = method_map[("Lcom/fastqq/app/MainActivity;", ("V", "V", ("Landroid/os/Bundle;",)), "onCreate")]

    class_data = bytearray()
    class_data.extend(make_leb128(0)) # static_fields_size
    class_data.extend(make_leb128(1)) # instance_fields_size
    class_data.extend(make_leb128(1)) # direct_methods_size
    class_data.extend(make_leb128(2)) # virtual_methods_size

    # Instance field: field_idx_diff = 0, access_flags = ACC_PRIVATE (0x02)
    class_data.extend(make_leb128(0))
    class_data.extend(make_leb128(0x0002))

    # Direct method: <init>
    class_data.extend(make_leb128(m_init_idx))
    class_data.extend(make_leb128(0x10001)) # ACC_PUBLIC | ACC_CONSTRUCTOR
    class_data.extend(make_leb128(data_off + code_init_off))

    # Virtual methods (sorted by method_idx):
    # Method 1: onBackPressed (method_idx = m_back_idx)
    # Method 2: onCreate (method_idx = m_create_idx)
    v_methods = [(m_back_idx, 0x0001, code_back_off), (m_create_idx, 0x0004, code_create_off)]
    v_methods.sort(key=lambda x: x[0])
    
    last_m_idx = 0
    for m_idx, access, code_off in v_methods:
        class_data.extend(make_leb128(m_idx - last_m_idx))
        class_data.extend(make_leb128(access))
        class_data.extend(make_leb128(data_off + code_off))
        last_m_idx = m_idx

    class_data_off = len(data_bytes)
    data_bytes.extend(class_data)
    align4(data_bytes)

    # Adjust all data offsets relative to data_off
    # Rebuild tables
    string_ids_bytes = b''.join(struct.pack('<I', data_off + off) for off in str_data_item_offs)
    type_ids_bytes = b''.join(struct.pack('<I', str_map[t]) for t in types)
    
    proto_ids_bytes = bytearray()
    for i, (shorty, ret, params) in enumerate(protos):
        tl_off = (data_off + proto_type_list_offs[i]) if proto_type_list_offs[i] > 0 else 0
        proto_ids_bytes.extend(struct.pack('<III', str_map[shorty], type_map[ret], tl_off))

    field_ids_bytes = bytearray()
    for cls_t, f_t, name_s in fields:
        field_ids_bytes.extend(struct.pack('<HHI', type_map[cls_t], type_map[f_t], str_map[name_s]))

    method_ids_bytes = bytearray()
    for cls_t, proto_t, name_s in methods:
        method_ids_bytes.extend(struct.pack('<HHI', type_map[cls_t], proto_map[proto_t], str_map[name_s]))

    # Class Def for MainActivity:
    # class_idx, access_flags, superclass_idx, interfaces_off, source_file_idx, annotations_off, class_data_off, static_values_off
    class_defs_bytes = struct.pack(
        '<IIIIIIII',
        type_map["Lcom/fastqq/app/MainActivity;"],
        0x0001, # ACC_PUBLIC
        type_map["Landroid/app/Activity;"],
        0, # interfaces_off
        str_map["MainActivity.java"],
        0, # annotations_off
        data_off + class_data_off,
        0  # static_values_off
    )

    # Map list (按偏移升序排列，必须包含所有 section 且含自身)
    align4(data_bytes)
    map_off = data_off + len(data_bytes)
    tl_offsets = [o for o in proto_type_list_offs if o > 0]
    map_items = [
        (0x0000, 1, 0),                                    # header
        (0x0001, len(strings), string_ids_off),            # string_ids
        (0x0002, len(types), type_ids_off),                # type_ids
        (0x0003, len(protos), proto_ids_off),              # proto_ids
        (0x0004, len(fields), field_ids_off),              # field_ids
        (0x0005, len(methods), method_ids_off),            # method_ids
        (0x0006, 1, class_defs_off),                       # class_defs
    ]
    if tl_offsets:
        map_items.append((0x1001, len(tl_offsets), data_off + tl_offsets[0]))  # type_list
    map_items.extend([
        (0x2002, len(strings), data_off + str_data_item_offs[0]),  # string_data
        (0x2001, 3, data_off + code_init_off),             # code_item (init/back/create 连续)
        (0x2000, 1, data_off + class_data_off),            # class_data
        (0x1000, 1, map_off),                              # map_list 自身
    ])
    map_bytes = struct.pack('<I', len(map_items))
    for t, n, o in map_items:
        map_bytes += struct.pack('<HHII', t, 0, n, o)
    data_bytes.extend(map_bytes)

    total_file_size = data_off + len(data_bytes)

    # Build Header
    dex_buf = bytearray(total_file_size)
    dex_buf[0:8] = b'dex\n035\0'
    struct.pack_into('<I', dex_buf, 32, total_file_size)
    struct.pack_into('<I', dex_buf, 36, header_size)
    struct.pack_into('<I', dex_buf, 40, 0x12345678) # endian_tag
    struct.pack_into('<II', dex_buf, 44, 0, 0)
    struct.pack_into('<I', dex_buf, 52, map_off) # map_off
    struct.pack_into('<II', dex_buf, 56, len(strings), string_ids_off)
    struct.pack_into('<II', dex_buf, 64, len(types), type_ids_off)
    struct.pack_into('<II', dex_buf, 72, len(protos), proto_ids_off)
    struct.pack_into('<II', dex_buf, 80, len(fields), field_ids_off)
    struct.pack_into('<II', dex_buf, 88, len(methods), method_ids_off)
    struct.pack_into('<II', dex_buf, 96, 1, class_defs_off)
    struct.pack_into('<II', dex_buf, 104, len(data_bytes), data_off)

    # Copy sections
    dex_buf[string_ids_off:string_ids_off + len(string_ids_bytes)] = string_ids_bytes
    dex_buf[type_ids_off:type_ids_off + len(type_ids_bytes)] = type_ids_bytes
    dex_buf[proto_ids_off:proto_ids_off + len(proto_ids_bytes)] = proto_ids_bytes
    dex_buf[field_ids_off:field_ids_off + len(field_ids_bytes)] = field_ids_bytes
    dex_buf[method_ids_off:method_ids_off + len(method_ids_bytes)] = method_ids_bytes
    dex_buf[class_defs_off:class_defs_off + len(class_defs_bytes)] = class_defs_bytes
    dex_buf[data_off:data_off + len(data_bytes)] = data_bytes

    # Calculate SHA-1 (bytes 32 to end)
    sha1 = hashlib.sha1(dex_buf[32:]).digest()
    dex_buf[12:32] = sha1

    # Calculate Adler32 (bytes 12 to end)
    adler = zlib.adler32(dex_buf[12:]) & 0xFFFFFFFF
    struct.pack_into('<I', dex_buf, 8, adler)

    return bytes(dex_buf)

# ==============================================================================
# 3. APK PACKAGING & PKCS#7 JAR SIGNING
# ==============================================================================
def create_app_icon_png():
    icon_path = os.path.join("public", "app-icon-192.png")
    if not os.path.isfile(icon_path):
        raise FileNotFoundError(
            "Linkey Android icon is missing. Run scripts/generate_app_ico.py first."
        )
    with open(icon_path, "rb") as icon_file:
        return icon_file.read()

def build_signed_apk(output_apk_path, server_url="http://192.168.1.8:3000"):
    manifest_bytes = build_binary_manifest(server_url=server_url)
    dex_bytes = create_valid_dex(server_url=server_url)
    icon_bytes = create_app_icon_png()

    entries = {
        "AndroidManifest.xml": manifest_bytes,
        "classes.dex": dex_bytes,
        "res/drawable/icon.png": icon_bytes,
        "res/drawable-hdpi/icon.png": icon_bytes,
        "res/drawable-xhdpi/icon.png": icon_bytes,
        "res/drawable-xxhdpi/icon.png": icon_bytes,
    }

    # Generate Manifest.MF
    manifest_lines = [
        "Manifest-Version: 1.0",
        "Created-By: 1.0 (Linkey APK Builder)",
        ""
    ]
    entry_digests = {}
    for name, data in entries.items():
        digest = hashlib.sha256(data).digest()
        b64 = hashlib.sha256(data).hexdigest()
        import base64
        b64_digest = base64.b64encode(digest).decode('ascii')
        manifest_lines.append(f"Name: {name}")
        manifest_lines.append(f"SHA-256-Digest: {b64_digest}")
        manifest_lines.append("")
        entry_digests[name] = b64_digest

    manifest_mf_bytes = "\r\n".join(manifest_lines).encode('utf-8')

    # Generate CERT.SF
    sf_lines = [
        "Signature-Version: 1.0",
        "Created-By: 1.0 (Linkey APK Builder)",
        f"SHA-256-Digest-Manifest: {base64.b64encode(hashlib.sha256(manifest_mf_bytes).digest()).decode('ascii')}",
        ""
    ]
    for name, b64_digest in entry_digests.items():
        # Section digest in Manifest.MF
        section = f"Name: {name}\r\nSHA-256-Digest: {b64_digest}\r\n\r\n".encode('utf-8')
        sf_lines.append(f"Name: {name}")
        sf_lines.append(f"SHA-256-Digest: {base64.b64encode(hashlib.sha256(section).digest()).decode('ascii')}")
        sf_lines.append("")

    cert_sf_bytes = "\r\n".join(sf_lines).encode('utf-8')

    # RSA 签名密钥持久化：首次生成并保存到 scripts/apk-signing-key.pem，
    # 之后每次构建复用同一密钥（证书可重新签发），保证 APK 能在手机上覆盖升级。
    KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'apk-signing-key.pem')
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH, 'rb') as kf:
            private_key = serialization.load_pem_private_key(kf.read(), password=None)
        print(f"[INFO] 复用持久化签名密钥: {KEY_PATH}")
    else:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
        )
        with open(KEY_PATH, 'wb') as kf:
            kf.write(private_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ))
        print(f"[INFO] 已生成并保存签名密钥: {KEY_PATH}")

    # X.509 证书每次从持久化密钥重新签发（签名密钥一致即可覆盖升级）
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Linkey Project"),
        x509.NameAttribute(NameOID.COMMON_NAME, "Linkey Android Release"),
    ])
    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        private_key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)
    ).not_valid_after(
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3650)
    ).sign(private_key, hashes.SHA256())

    cert_der = cert.public_bytes(serialization.Encoding.DER)

    # Sign CERT.SF with RSA-SHA256
    signature = private_key.sign(
        cert_sf_bytes,
        padding.PKCS1v15(),
        hashes.SHA256()
    )

    # Build PKCS#7 / CMS ContentInfo SignedData structure
    # SignedData ::= SEQUENCE {
    #   version CMSVersion (1),
    #   digestAlgorithms SET OF DigestAlgorithmIdentifier,
    #   encapContentInfo EncapsulatedContentInfo,
    #   certificates [0] IMPLICIT CertificateSet OPTIONAL,
    #   signerInfos SignerInfos
    # }
    def asn1_len(length):
        if length < 128:
            return bytes([length])
        elif length < 256:
            return bytes([0x81, length])
        elif length < 65536:
            return bytes([0x82, (length >> 8) & 0xFF, length & 0xFF])
        else:
            return bytes([0x83, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF])

    def asn1_seq(data):
        return b'\x30' + asn1_len(len(data)) + data

    def asn1_set(data):
        return b'\x31' + asn1_len(len(data)) + data

    # OIDs
    OID_PKCS7_SIGNED_DATA = bytes.fromhex("2a864886f70d010702")
    OID_PKCS7_DATA = bytes.fromhex("2a864886f70d010701")
    OID_SHA256 = bytes.fromhex("608648016503040201")
    OID_RSA_ENCRYPTION = bytes.fromhex("2a864886f70d010101")

    # DigestAlgorithmIdentifier (SHA-256)
    digest_algo = asn1_seq(b'\x06' + asn1_len(len(OID_SHA256)) + OID_SHA256 + b'\x05\x00')
    digest_algos = asn1_set(digest_algo)

    # EncapContentInfo (empty data for detached signature)
    encap_content = asn1_seq(b'\x06' + asn1_len(len(OID_PKCS7_DATA)) + OID_PKCS7_DATA)

    # Certificates [0] IMPLICIT
    certs_tag = b'\xa0' + asn1_len(len(cert_der)) + cert_der

    # SignerInfo
    # IssuerAndSerialNumber
    issuer_der = cert.issuer.public_bytes()
    serial_der = b'\x02' + asn1_len(len(cert.serial_number.to_bytes((cert.serial_number.bit_length() + 7) // 8, 'big'))) + cert.serial_number.to_bytes((cert.serial_number.bit_length() + 7) // 8, 'big')
    issuer_and_serial = asn1_seq(issuer_der + serial_der)

    # DigestEncryptionAlgorithmIdentifier (rsaEncryption)
    digest_enc_algo = asn1_seq(b'\x06' + asn1_len(len(OID_RSA_ENCRYPTION)) + OID_RSA_ENCRYPTION + b'\x05\x00')
    
    # EncryptedDigest (signature)
    sig_octets = b'\x04' + asn1_len(len(signature)) + signature

    signer_info = asn1_seq(
        b'\x02\x01\x01' + # version 1
        issuer_and_serial +
        digest_algo +
        digest_enc_algo +
        sig_octets
    )
    signer_infos = asn1_set(signer_info)

    # SignedData sequence
    signed_data = asn1_seq(
        b'\x02\x01\x01' + # version 1
        digest_algos +
        encap_content +
        certs_tag +
        signer_infos
    )

    # ContentInfo (pkcs7-signedData)
    pkcs7_der = asn1_seq(
        b'\x06' + asn1_len(len(OID_PKCS7_SIGNED_DATA)) + OID_PKCS7_SIGNED_DATA +
        b'\xa0' + asn1_len(len(signed_data)) + signed_data
    )

    # =====================================================================
    # v1 (JAR) + v2 (APK Signature Scheme v2) 双签名
    # v1 兼容 Android 5/6；v2 满足 Android 11+ 对 targetSdk>=30 的强制要求
    # =====================================================================
    import io as _io

    def lp(data: bytes) -> bytes:
        """APK 签名块使用的 u32 长度前缀"""
        return struct.pack('<I', len(data)) + data

    def chunked_digest(data: bytes) -> bytes:
        """v2 分块摘要: SHA256(0x5a || u32le(count) || concat(SHA256(0xa5 || u32le(len) || chunk)))"""
        CHUNK = 1024 * 1024
        chunks = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)] or [b'']
        parts = [hashlib.sha256(b'\xa5' + struct.pack('<I', len(c)) + c).digest() for c in chunks]
        return hashlib.sha256(b'\x5a' + struct.pack('<I', len(parts)) + b''.join(parts)).digest()

    # 1. 在内存生成含 v1 签名文件的 ZIP（条目区 + 中央目录 + EOCD）
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            comp = zipfile.ZIP_STORED if name.endswith('.png') else zipfile.ZIP_DEFLATED
            zf.writestr(name, data, compress_type=comp)
        zf.writestr("META-INF/MANIFEST.MF", manifest_mf_bytes, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("META-INF/CERT.SF", cert_sf_bytes, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("META-INF/CERT.RSA", pkcs7_der, compress_type=zipfile.ZIP_STORED)
    raw = buf.getvalue()

    # 2. 解析 EOCD / 中央目录
    eocd_sig = b'PK\x05\x06'
    eocd_pos = raw.rfind(eocd_sig)
    if eocd_pos < 0:
        raise RuntimeError('EOCD not found')
    cd_size, cd_offset = struct.unpack_from('<II', raw, eocd_pos + 12)
    entries_region = raw[:cd_offset]
    cd_region = raw[cd_offset:cd_offset + cd_size]
    eocd_region = bytearray(raw[eocd_pos:])

    # 3. 构造 v2 签名块（先定尺寸，再回填 EOCD 的 CD 偏移）
    ALGO_RSA_PKCS1_SHA256 = 0x0101
    content_digest = hashlib.sha256(
        chunked_digest(entries_region) + chunked_digest(cd_region) + chunked_digest(bytes(eocd_region))
    ).digest()

    pubkey_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )

    def build_v2_value(cd_offset_final: int) -> bytes:
        eocd_patched = bytearray(eocd_region)
        struct.pack_into('<I', eocd_patched, 16, cd_offset_final)
        total_digest = hashlib.sha256(
            chunked_digest(entries_region) + chunked_digest(cd_region) + chunked_digest(bytes(eocd_patched))
        ).digest()

        digest_record = struct.pack('<I', ALGO_RSA_PKCS1_SHA256) + lp(total_digest)
        digests = lp(lp(digest_record))
        certs = lp(lp(cert_der))
        attrs = lp(b'')  # 空附加属性
        signed_data = digests + certs + attrs

        signature = private_key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
        sig_record = struct.pack('<I', ALGO_RSA_PKCS1_SHA256) + lp(signature)
        signer = lp(signed_data) + lp(lp(sig_record)) + lp(pubkey_der)
        return lp(lp(signer))

    # 块布局: [u64 size_value][pair: u64 pairLen + u32 id + value][u64 size_value][16B magic]
    # size_value = pair 区域 + 8(第二个 size) + 16(magic)，块总长 = size_value + 8。
    # value 尺寸与 cd_offset 无关，先试算尺寸再按真实偏移重建一次。
    v2_value = build_v2_value(0)
    pair_body = struct.pack('<Q', 4 + len(v2_value)) + struct.pack('<I', 0x7109871a) + v2_value
    size_value = len(pair_body) + 8 + 16
    new_cd_offset = cd_offset + size_value + 8

    eocd_for_digest = bytearray(eocd_region)
    struct.pack_into('<I', eocd_for_digest, 16, new_cd_offset)
    v2_value = build_v2_value(new_cd_offset)
    pair_body = struct.pack('<Q', 4 + len(v2_value)) + struct.pack('<I', 0x7109871a) + v2_value
    size_value = len(pair_body) + 8 + 16
    signing_block = (struct.pack('<Q', size_value) + pair_body +
                     struct.pack('<Q', size_value) + b'APK Sig Block 42')

    # 4. 组装最终 APK: 条目区 || 签名块 || 中央目录 || EOCD(回填 CD 偏移)
    eocd_final = bytearray(eocd_region)
    struct.pack_into('<I', eocd_final, 16, cd_offset + len(signing_block))  # EOCD 偏移 16 处为 CD offset 字段
    final_apk = entries_region + signing_block + cd_region + bytes(eocd_final)

    with open(output_apk_path, 'wb') as f:
        f.write(final_apk)

    print(f"[SUCCESS] Signed Android APK generated (v1+v2): {output_apk_path} ({os.path.getsize(output_apk_path)} bytes)")

if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else f"http://{get_lan_ip()}:3000"
    out = sys.argv[2] if len(sys.argv) > 2 else "Linkey-Android.apk"
    print(f"[INFO] APK 将连接: {url}")
    build_signed_apk(out, url)
