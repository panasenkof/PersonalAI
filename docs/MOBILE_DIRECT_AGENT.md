# PersAI: assistant and memory on the phone

Install the signed native Android APK (SQLCipher and speech require a native
build; Expo Go is insufficient). Unlock **the application**, choose phone mode,
then open Settings → Models and connections. Server PersonalAI is optional.
`PIA_ANDROID_PACKAGE` remains **com.paigent.app**; keep the existing signing key.

## Connections

The app supports OpenAI Responses, OpenAI-compatible Chat Completions and
Anthropic-compatible Messages. Each saved connection has its own name, endpoint,
API key, chat model, transcription model and permissions. Several connections
using the same protocol are supported. Select a connection and Save: all drafts
are persisted and the screen closes. Changing endpoints clears that draft's key.
Credentials never move to another endpoint/profile automatically. Old settings
are migrated; the previous whole configuration remains active if a save fails.

A local OpenAI-compatible server on the private network may use HTTP without a
key. The model runs there, not inside PersAI on the phone. Public APIs use HTTPS.
Cloud calls may cost money. At most four model calls and 1200 output tokens per
call for chat; extraction is a separate user-initiated request. Set a monetary
budget at the provider too.

## Memory first, internet when needed

The model's permission to read ordinary notes and the internet toggle start off.
When memory is allowed, each turn searches it **before** calling the LLM/search.
Only active standard notes from standard collections may be passed to the model;
unclassified, sensitive and secret notes remain excluded. At most five bounded
fragments are sent. A match avoids web search unless the user asks for current
information. Per-message “не используй интернет” also disables web access.

Search choices:
- **Without registration:** public Bing RSS; no separate account or API key.
  This is best-effort, with limited results. CAPTCHA, unavailable feeds and network
  failures are reported; the app does not silently send queries elsewhere.
- **Brave Search API:** separate search key, works independently of the LLM.
- **Built-in OpenAI search:** Responses tool, with potential provider charges.

Sources and memory content are treated as data, not instructions. A failed
memory lookup is reported as unavailable, never as proof the memory is empty.
New agent notes are proposals until the user confirms Save.

## Dictation and files

The microphone drafts Russian text; it never sends the message automatically.
On-device speech is preferred. If unavailable, the user can explicitly choose the
phone's system speech service, which may send audio to its provider. No separate
PersAI registration is required. Recognition requires an installed service and
language support; microphone denial is handled explicitly.

Memory and Assistant offer **Add information from a file**:
- Text: read on the phone, no provider transmission; up to 60,000 characters.
- JPEG/PNG/WebP/GIF: selected vision model; up to 8 MB.
- Audio: selected OpenAI-compatible `/audio/transcriptions` endpoint and configured
  transcription model (`whisper-1` default); up to 20 MB. Anthropic does not provide
  this endpoint; select another saved connection for audio.
- Video: five ordered frames at 2/25/50/75/97 percent of the duration; up to 80 MB.
  This samples visual content, **does not transcribe the audio track** and cannot
  describe every event in the video.

Media is private by default. External extraction is a separate explicit action
for the selected file; it requires selecting ordinary data and the provider.
Review/edit the extracted text, then save it as a note with source filename and
sensitivity. Original media is not retained in the notes backup. Picker copies
and extracted frames are cleaned up. Encrypted backup/restore is a collapsed
section in Memory; the recovery code is kept separately from the exported file.

## Verification

`npm run typecheck`, `npm test -- --runInBand`,
`node scripts/verify-mobile-ui.cjs`, Expo install check and Android/iOS exports.
The browser suite renders the production screens with simulated native services
and storage; it does not prove SQLCipher, actual hardware biometrics or STT.
Native CI builds the APK; complete [native device acceptance](MOBILE_NATIVE_QA.md).

Still separate future work: a model running on the phone, durable local chat
history, streaming, shared server/mobile memory, sync and automatic routing of
expensive tasks to a server. File/voice import above does not implement those.
