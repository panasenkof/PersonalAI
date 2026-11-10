import io
import pathlib
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from unpack_verified import REQUIRED, unpack


def make_bundle(path, *, malicious=None):
    with tarfile.open(path, "w:gz") as archive:
        for filename in sorted(REQUIRED):
            data = b"dummy-content"
            info = tarfile.TarInfo(filename)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if malicious is not None:
            info = tarfile.TarInfo(malicious)
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))


class TdlibArchiveTest(unittest.TestCase):
    def test_extract_only_expected_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = pathlib.Path(temporary, "source.tar.gz")
            dst = pathlib.Path(temporary, "extract")
            make_bundle(src)
            unpack(str(src), str(dst))
            for name in REQUIRED:
                self.assertEqual((dst / name).read_bytes(), b"dummy-content")

    def test_reject_path_traversal_before_writing_any_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = pathlib.Path(temporary, "bad.tar.gz")
            dst = pathlib.Path(temporary, "extract")
            make_bundle(src, malicious="bundle/../../escaped.txt")
            with self.assertRaisesRegex(ValueError, "unsafe_entry"):
                unpack(str(src), str(dst))
            self.assertFalse((pathlib.Path(temporary, "escaped.txt")).exists())
            self.assertEqual(list(dst.rglob("*")), [])

    def test_reject_duplicate_and_symlinked_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            src = pathlib.Path(temporary, "bad.tar.gz")
            with tarfile.open(src, "w:gz") as archive:
                for name in sorted(REQUIRED):
                    info = tarfile.TarInfo(name)
                    if name.endswith("JsonClient.java"):
                        info.type = tarfile.SYMTYPE
                        info.linkname = "/etc/passwd"
                    else:
                        info.size = 1
                    archive.addfile(info, io.BytesIO(b"x") if info.isfile() else None)
            with self.assertRaisesRegex(ValueError, "unsafe_entry"):
                unpack(str(src), str(pathlib.Path(temporary, "extract")))
