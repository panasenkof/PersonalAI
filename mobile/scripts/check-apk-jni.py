#!/usr/bin/env python3
"""Fail closed on known, release-critical Java/JNI classes missing from APK.

Works on DEX class definitions, NOT 'strings' matches (which are unreliable).
Optional native-string findings are advisory, never claimed as a full proof.
Usage: python3 mobile/scripts/check-apk-jni.py app-release.apk
"""
import re
import struct
import sys
import zipfile


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def dex_classes(data):
    if len(data) < 112 or not data.startswith(b"dex\n"):
        raise ValueError("Invalid DEX file")
    strings = u32(data, 0x3C)
    types = u32(data, 0x44)
    count, defs = struct.unpack_from("<II", data, 0x60)
    if count > 2_000_000:
        raise ValueError("Invalid DEX class count")
    result = set()
    for i in range(count):
        typ = u32(data, defs + i * 32)
        name = u32(data, types + typ * 4)
        pos = u32(data, strings + name * 4)
        for _ in range(5):
            byte = data[pos]
            pos += 1
            if byte < 128:
                break
        else:
            raise ValueError("Invalid DEX string length")
        end = data.index(b"\0", pos)
        descriptor = data[pos:end].decode("utf-8")
        if descriptor.startswith("L") and descriptor.endswith(";"):
            result.add(descriptor[1:-1])
    return result


ALWAYS = {
    "expo/modules/persaidiagnostics/PersaiCrashDiagnosticsModule",
    "expo/modules/persaipdf/PersaiPdfTextModule",
    "expo/modules/persaivoice/PersaiVoiceActivityModule",
    "com/googlecode/tesseract/android/TessBaseAPI",
}
# Unlike a generic heuristic, these are known java counterparts of packaged
# JNI libraries and must be present even when R8 removes their entire package.
CONDITIONAL = {
    "libexecutorch.so": {"org/pytorch/executorch/EValue"},
    "libonnxruntime4j_jni.so": {"ai/onnxruntime/TensorInfo"},
    "libtdjsonjava.so": {"org/drinkless/tdlib/JsonClient"},
}
PLATFORM = ("android/", "java/", "javax/", "dalvik/", "kotlin/")


def inspect_apk(apk):
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        dex_names = [n for n in names if re.fullmatch(r"classes\d*\.dex", n)]
        if not dex_names:
            raise ValueError("APK has no root DEX files")
        classes = set()
        for name in dex_names:
            classes.update(dex_classes(archive.read(name)))
        libraries = {n.rsplit("/", 1)[-1] for n in names if re.fullmatch(r"lib/[^/]+/[^/]+\.so", n)}
        required = set(ALWAYS)
        for library, critical in CONDITIONAL.items():
            if library in libraries:
                required.update(critical)
        missing = sorted(required - classes)
        print(f"APK: {apk}; {len(classes)} classes; {len(libraries)} native libraries")
        for item in sorted(required):
            print(f"  {'MISSING' if item in missing else 'OK'} {item}")
        # This is only a heuristic: native libraries can construct class names
        # dynamically, while R8 can rename complete packages or their members.
        candidates = set()
        packages = {c.rsplit("/", 1)[0] for c in classes if "/" in c}
        for name in names:
            if not name.endswith(".so"):
                continue
            content = archive.read(name)
            for m in re.finditer(rb"(?<![\w/$])L?((?:[a-z][a-z0-9_]*/)+[A-Z][\w$]*)(?![\w/$])", content):
                cls = m.group(1).decode("ascii")
                if cls not in classes and not cls.startswith(PLATFORM) and cls.rsplit("/", 1)[0] in packages:
                    candidates.add(cls)
        print(f"Advisory: {len(candidates)} unresolved native-looking name(s); manual review needed")
        if missing:
            raise ValueError("JNI critical classes missing: " + ", ".join(missing))
        return classes


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: check-apk-jni.py app-release.apk")
        inspect_apk(sys.argv[1])
    except (ValueError, OSError, EOFError, struct.error, zipfile.BadZipFile) as error:
        print("::error::" + str(error), file=sys.stderr)
        sys.exit(1)
