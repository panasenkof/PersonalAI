# PR2.B2 — TDLib JSONJava gateway (code, native binary pending)

## Result and limitations
An Android Expo module bridges only whitelisted account authorization functions
to official-source TDLib JSONJava: initialize, phone, code, password, email,
email code, logout and close. Events contain only an authorization state.
There is no arbitrary request execution, sending messages or listing private
conversations from JS/LLM. If official JSONJava native library and Java binding
are not staged, the module returns unavailable and performs no Telegram access.

User-facing login, Saved Messages topics, download of media and canonical note
import are NOT implemented by this PR; do not present them as working.

## Privacy/security
- All account requests require existing application unlock from JS.
- TDLib encrypts its on-disk session using an independent, device-only 32-byte
  SecureStore key; this is intentionally excluded from portable backup.
- Runtime has one receiver and at most one profile, restricted to app-private
  TDLib directory; no secret chats and no persistent message/chat/file database.
- Auth code/password, phone and API hash never appear in logs or events. TDLib
  errors are sanitized rather than returned as raw network exceptions.
- No arbitrary chat read endpoints yet; next PR must explicitly scope to
  getMe/self-chat and Saved Messages topic history.
- Android SDK 26+, without new permission, background service or remote relay.
- Later UI integration must close the TDLib session on AppLock and provide
  explicit revoke/logout with verification of closed state and local cache
  removal. Until then no real login is exposed in the application.

## C0-A/C3-B review
Single canonical SQLCipher writer saveMediaNote, existing memory search and
existing reserved Telegram Bot API remain unchanged. The new native database is
TDLib's own encrypted session/cache, not a second PersAI note store.
All changes are isolated to mobile/modules/persai-tdlib and typed client adapter
plus SecureStore key. Exact SHA CI / Android native build required; source
artifact/manual build and Vivo live login separate gate.
