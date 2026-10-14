# PersAI: assistant and memory on the phone

PersAI has no server of its own. The app talks directly to the model provider
the user configures; memory and chat history stay in the encrypted database
on the phone.

Install the signed native Android APK (SQLCipher and speech require a native
build; Expo Go is insufficient). Unlock **the application**, then open
Settings → Models and connections.
`PIA_ANDROID_PACKAGE` remains **com.paigent.app**; keep the existing signing key.

## Connections

The app supports OpenAI Responses, OpenAI-compatible Chat Completions and
Anthropic-compatible Messages. Each saved connection has its own name, endpoint,
API key, chat model, transcription model and web-search preferences. Several connections
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

Every turn searches ordinary memory **before** calling the LLM/search. There is no
separate memory permission or unlock. Internet search starts off.
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

Memory and Home offer **Add information from a file**:
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
and extracted frames are cleaned up. Encrypted backup/restore is a separate screen reached from Memory or Settings;
notes and local chat history are included. The recovery code is kept separately
from the exported file. Backups created before chat history are still supported.

## Home, history and application session

There are three tabs: Home, Memory and Settings. Home owns the complete assistant
UI, dictation, import entry point and searchable conversation history. Model
connections have one editor under Settings → Models and connections.

Messages, citations and pending note proposals are stored in the existing
per-profile SQLCipher database. Navigation does not own model requests: switching
tabs or conversations cannot abort, duplicate or resend a turn. Stop explicitly
aborts it. A lock or app exit never resends a turn. An app cold start
restores completed history and reports interrupted turns without re-spending them.
A storage failure keeps visible data and offers a retry; an unsaved question never
starts a model request.

A cold start authenticates the whole application. Background/inactive/Android
blur immediately adds an opaque privacy cover. Returning within **five minutes**
requires no new prompt, including file pickers/sharing. After five minutes outside
the app, the application session is revoked and SQLCipher closes. Foreground
checks the deadline even when the OS suspended the timer. The navigation and
job owner remain mounted behind the cover. A completed response waits for app
unlock before saving. Android/iOS may still suspend or terminate the process;
this is not a native background execution service.

Memory is an overview of themed sections, search, current records and archive.
Opening/creating a record leads to a separate editor; changes retain source
metadata and revision history. Moving sections and archiving use version checks.
Events, relations and revisions are in an optional details panel. Backup/restore
is separate from the editor.

## Keyboard and bottom panels

Android uses resize mode; tabs hide while the keyboard is visible. The composer
uses a full-width text field and a separate tool row, with no duplicated bottom
safe-area inset from the tab bar. Stack editors account for header height on iOS
and system bottom insets. History, section selection and attachments share a
scrollable keyboard-aware BottomSheet with safe-area padding, a dismiss backdrop
and Android Back handling. Browser resized-height checks approximate layout;
actual IME, gesture navigation, three-button navigation and enlarged fonts require
[phone acceptance](DEVICE_QA.md).

## Verification

Use Node 22.13+ (CI uses Node 22) for the real SQLite regression adapter.
`npm run typecheck`, `npm test -- --runInBand`,
`node scripts/verify-mobile-ui.cjs`, Expo install check and Android/iOS exports.
The browser suite renders the production screens with simulated native services
and storage; it does not prove SQLCipher, actual hardware biometrics or STT.
Native CI builds the APK; complete [native device acceptance](DEVICE_QA.md).

Planned work (see the README roadmap): structured memory sections, streaming,
semantic search, learning from corrections, and device-to-device transfer through
an encrypted copy in the user's own cloud storage — still without a PersAI server.
