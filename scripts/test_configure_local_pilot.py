import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("configure-local-pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotConfigurationTest(unittest.TestCase):
    def test_generates_distinct_keys_and_preserves_existing_installation(self):
        template = Path(__file__).resolve().parents[1] / ".env.example"
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / ".env"
            pilot.configure(destination, template)
            original = destination.read_bytes()
            values = dict(line.split("=", 1) for line in original.decode().splitlines()
                          if line and not line.startswith("#") and "=" in line)
            self.assertEqual(values["PUBLIC_LAUNCH"], "false")
            self.assertEqual(values["REQUIRE_VERIFIED_EMAIL"], "false")
            self.assertGreaterEqual(len(values["JWT_SECRET"]), 32)
            self.assertTrue(values["POSTGRES_PASSWORD"])
            for key in ["PIA_AGENT_SECRET", "BACKUP_ENCRYPTION_KEY"]:
                self.assertEqual(len(base64.urlsafe_b64decode(values[key])), 32)
            self.assertNotEqual(values["PIA_AGENT_SECRET"], values["BACKUP_ENCRYPTION_KEY"])
            with self.assertRaises(FileExistsError):
                pilot.configure(destination, template)
            self.assertEqual(destination.read_bytes(), original)
            other = Path(directory) / "other.env"
            pilot.configure(other, template)
            self.assertNotEqual(other.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
