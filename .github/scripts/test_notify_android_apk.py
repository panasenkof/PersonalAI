#!/usr/bin/env python3
"""Dependency-free tests for the Telegram APK notification helper."""

import importlib.util
import io
import pathlib
import unittest
import urllib.error
import urllib.parse


MODULE_PATH = pathlib.Path(__file__).with_name("notify-android-apk.py")
spec = importlib.util.spec_from_file_location("notify_android_apk", MODULE_PATH)
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)

TAG = "android-test-b123-a1"
APK = f"PersAI-{TAG}.apk"
SHA = "a" * 40


class TelegramApkNotificationTests(unittest.TestCase):
    def test_message_links_to_actual_apk_and_release(self):
        message = notify.notification_text("panasenkof/PersonalAI", TAG, APK, "12301", SHA)
        self.assertIn(f"https://github.com/panasenkof/PersonalAI/releases/download/{TAG}/{APK}", message)
        self.assertIn(f"https://github.com/panasenkof/PersonalAI/releases/tag/{TAG}", message)
        self.assertIn("versionCode 12301", message)
        self.assertIn("Коммит: aaaaaaaa", message)

    def test_rejects_unexpected_release_identity(self):
        with self.assertRaises(ValueError):
            notify.notification_text("panasenkof/PersonalAI", TAG, "../evil.apk", "12301", SHA)
        with self.assertRaises(ValueError):
            notify.notification_text("panasenkof/PersonalAI", "main", APK, "12301", SHA)

    def test_post_uses_form_body_not_query_parameters(self):
        calls = []
        def opener(request, timeout):
            calls.append(request)
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(timeout, 20)
            self.assertEqual(
                urllib.parse.parse_qs(request.data.decode()),
                {"chat_id": ["-1001234"], "text": ["PersAI готов"], "disable_web_page_preview": ["true"]},
            )
            return io.BytesIO(b'{"ok": true}')
        notify.send("123:TEST_TOKEN", "-1001234", "PersAI готов", opener=opener)
        self.assertEqual(len(calls), 1)

    def test_transient_failure_is_retried(self):
        count = []
        def opener(request, timeout):
            count.append(1)
            if len(count) == 1:
                raise urllib.error.URLError("network")
            return io.BytesIO(b'{"ok": true}')
        notify.send("123:TEST_TOKEN", "42", "ok", opener=opener, sleeper=lambda _: None)
        self.assertEqual(len(count), 2)

    def test_invalid_chat_prevents_network_send(self):
        with self.assertRaises(ValueError):
            notify.send("123:TEST_TOKEN", "@username", "hi", opener=lambda *_args, **_kwargs: self.fail("network attempted"))

    def test_errors_do_not_expose_secret(self):
        def opener(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)
        with self.assertRaises(RuntimeError) as caught:
            notify.send("123:TOP_SECRET", "42", "hi", opener=opener, sleeper=lambda _: None)
        self.assertIn("HTTP 403", str(caught.exception))
        self.assertNotIn("TOP_SECRET", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
