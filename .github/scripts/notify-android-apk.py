#!/usr/bin/env python3
"""Notify an existing Telegram bot after a signed PersAI APK is published.

Uses the same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets as TVprogram.
Requires only the Python standard library; never logs credentials or API URLs.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def notification_text(repo, tag, apk_name, version_code, commit_sha):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid GitHub repository")
    if not re.fullmatch(r"android-test-b[0-9]+-a[0-9]+", tag):
        raise ValueError("Invalid Android release tag")
    if apk_name != f"PersAI-{tag}.apk":
        raise ValueError("Unexpected APK filename")
    if not re.fullmatch(r"[0-9]+", version_code):
        raise ValueError("Invalid Android version code")
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise ValueError("Invalid Android release commit")

    url = f"https://github.com/{repo}/releases/download/{tag}/{apk_name}"
    release = f"https://github.com/{repo}/releases/tag/{tag}"
    return (
        "📱 PersAI: новый APK готов\n"
        f"Сборка: {tag} (versionCode {version_code})\n"
        f"Коммит: {commit_sha[:8]}\n"
        f"Скачать APK: {url}\n"
        f"Страница релиза: {release}\n"
        "\nУстанавливайте поверх текущей версии, не удаляя приложение."
    )


def send(token, chat_id, message, opener=urllib.request.urlopen, sleeper=time.sleep):
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        raise ValueError("TELEGRAM_BOT_TOKEN is missing or invalid")
    if not re.fullmatch(r"-?[0-9]+", chat_id):
        raise ValueError("TELEGRAM_CHAT_ID is missing or invalid")
    body = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": message,
        "disable_web_page_preview": "true",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        method="POST",
    )
    # Telegram/runner transient errors should not discard the first successful release.
    for attempt in range(3):
        try:
            with opener(request, timeout=20) as response:
                result = json.load(response)
            if not isinstance(result, dict) or not result.get("ok"):
                raise RuntimeError("Telegram rejected notification")
            return
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"Telegram HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 2:
                raise RuntimeError("Telegram request failed") from None
        except (ValueError, TypeError):
            # Avoid a traceback containing the request URL and bot token.
            raise RuntimeError("Telegram returned an invalid response") from None
        if attempt < 2:
            sleeper(2 * (attempt + 1))


def main():
    env = os.environ
    message = notification_text(
        env.get("GITHUB_REPOSITORY", ""),
        env.get("APK_TAG", ""),
        env.get("APK_NAME", ""),
        env.get("APK_VERSION_CODE", ""),
        env.get("TARGET_SHA", ""),
    )
    send(
        env.get("TELEGRAM_BOT_TOKEN", "").strip(),
        env.get("TELEGRAM_CHAT_ID", "").strip(),
        message,
    )
    print("Telegram APK notification sent.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as exc:
        # Never print the Bot API request URL (contains the secret token).
        print(f"::warning::{exc}", file=sys.stderr)
        sys.exit(1)
