# External speech-to-text: per-file privacy gate

A user-wide `allow_remote_stt=true` flag is not permission to disclose
every new voice note. External Whisper-compatible endpoints may receive audio
bytes, so third-party STT now requires **all** of these conditions:

1. The owner explicitly enabled remote speech transcription.
2. The uploaded blob is owned by that user and its stored MIME really is
   `audio/*` (untrusted envelope metadata is insufficient).
3. The source blob is explicitly classified as `standard` and belongs to a
   classified collection.
4. That exact collection allows remote extraction.

Unknown, sensitive or secret blobs, conflicting/forged MIME metadata and
revoked collection permissions deny the external network call; a message
explains that classification/consent is needed. The data is **never read**
by an external STT provider on denied calls. Locally configured loopback
speech transcribers can still operate without remote egress consent.

This intentionally tightens third-party audio behavior for existing users:
old uploaded voice files remain unclassified until explicitly approved.

Test coverage: opt-in absent, global-only, unclassified, sensitive, explicit
standard grant, revoked grant, MIME forgery, other account, local STT.
