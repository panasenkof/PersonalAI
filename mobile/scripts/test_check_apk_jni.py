"""Regression tests for R8/JNI APK class retention without needing Android SDK."""
import importlib.util
import pathlib
import struct
import tempfile
import unittest
import zipfile

PATH = pathlib.Path(__file__).with_name("check-apk-jni.py")
SPEC = importlib.util.spec_from_file_location("check_apk_jni", PATH)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def make_dex(classes):
    count = len(classes)
    string_off, type_off, def_off = 112, 112 + 4 * count, 112 + 8 * count
    raw = bytearray(def_off + 32 * count)
    raw[:8] = b"dex\n035\0"
    struct.pack_into("<I", raw, 0x3C, string_off)
    struct.pack_into("<I", raw, 0x44, type_off)
    struct.pack_into("<II", raw, 0x60, count, def_off)
    for idx, cls in enumerate(sorted(classes)):
        encoded = ("L" + cls + ";").encode("ascii")
        pos = len(raw)
        n = len(encoded)
        while n >= 128:
            raw.append((n & 127) | 128)
            n >>= 7
        raw.append(n)
        raw.extend(encoded + b"\0")
        struct.pack_into("<I", raw, string_off + idx * 4, pos)
        struct.pack_into("<I", raw, type_off + idx * 4, idx)
        struct.pack_into("<I", raw, def_off + idx * 32, idx)
    return raw


def make_apk(classes, libraries=()):
    f = tempfile.NamedTemporaryFile(suffix=".apk", delete=False)
    f.close()
    with zipfile.ZipFile(f.name, "w") as apk:
        apk.writestr("classes.dex", make_dex(classes))
        for lib in libraries:
            apk.writestr("lib/arm64-v8a/" + lib, b"")
    return pathlib.Path(f.name)


class JniAuditTests(unittest.TestCase):
    def check(self, classes, libs=(), missing=None):
        path = make_apk(classes, libs)
        try:
            if missing:
                with self.assertRaisesRegex(ValueError, missing):
                    CHECK.inspect_apk(path)
            else:
                CHECK.inspect_apk(path)
        finally:
            path.unlink()

    def test_present(self):
        self.check(CHECK.ALWAYS)

    def test_removed_voice_bridge_class_fails(self):
        self.check(CHECK.ALWAYS - {"expo/modules/persaivoice/PersaiVoiceActivityModule"}, missing="PersaiVoiceActivityModule")

    def test_removed_tesseract_class_fails(self):
        self.check(CHECK.ALWAYS - {"com/googlecode/tesseract/android/TessBaseAPI"}, missing="TessBaseAPI")

    def test_executorch_binary_needs_evalue_even_if_package_disappears(self):
        self.check(CHECK.ALWAYS, ["libexecutorch.so"], missing="EValue")
        self.check(CHECK.ALWAYS | {"org/pytorch/executorch/EValue"}, ["libexecutorch.so"])

    def test_tdlib_binary_needs_jsonclient_only_when_staged(self):
        self.check(CHECK.ALWAYS, ["libtdjsonjava.so"], missing="JsonClient")
        self.check(CHECK.ALWAYS | {"org/drinkless/tdlib/JsonClient"}, ["libtdjsonjava.so"])


if __name__ == "__main__":
    unittest.main()
