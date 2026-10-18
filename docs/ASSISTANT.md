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
Cloud calls may cost money. At most four model calls per question and 4000 output
tokens per call (8000 for reasoning models such as o-series and gpt-5); an answer
cut by the limit is kept with a note. Extraction is a separate user-initiated
request. Set a monetary budget at the provider too.

Ready-made connections: YandexGPT (Yandex AI Studio; the folder ID is part of the
model URI and is also sent as `OpenAI-Project`), DeepSeek, OpenRouter, a local
model (Ollama, LM Studio), OpenAI and Anthropic. "Проверить связь" sends one short
request through the normal chat path before saving. GigaChat is not offered: it
needs an OAuth token exchange and a certificate authority Android does not trust
by default.

Answers stream as they are written. React Native's fetch cannot read a body
incrementally, so streamed calls use XMLHttpRequest with Server-Sent Events and
fold the events back into the provider's normal JSON reply.

## Memory first, internet when needed

Every turn follows the same order:

1. **Memory, every way it can be searched:** the whole phrase, each keyword,
   then each keyword without its Russian ending as a prefix («машину» finds
   «машина», «машины»). Notes matched by more of these searches rank first;
   results are ordered by relevance (bm25). At most five fragments, only from
   active notes in standard sections, are passed to the model.
2. **If memory has nothing, the user is told so in the chat** — «В памяти ничего
   не нашлось. Ищу в интернете.» — and the web is searched (when web search is on
   for the connection). With web search off, or after «не используй интернет»,
   the message says why the web was not used.
3. **If memory has an answer, the web is not used**, unless the question asks for
   current information («сегодня», «новости», «актуальный курс»…).

Questions about the user themselves («что ты помнишь обо мне») are answered from
memory only. A failed search never ends the turn: the model answers without it
and the chat shows the exact reason. Unclassified, sensitive and secret notes
never leave the phone.

Search choices:
- **Yandex (Yandex Cloud Search API):** works from Russia, about 0.49 ₽ per search,
  billed to the user's Yandex Cloud account. Needs a service account with the
  `search-api.webSearch.user` role, an API key with the `yc.search-api.execute`
  scope and the folder ID. `POST https://searchapi.api.cloud.yandex.net/v2/web/search`,
  `Authorization: Api-Key …`; the XML result arrives Base64-encoded in `rawData`.
- **Tavily:** free 1,000 searches a month; rejects requests from Russia with HTTP 403,
  so from Russia it works only through a VPN.
- **Built-in OpenAI search:** Responses tool, with potential provider charges.

Each search service keeps its own key (stored together as one JSON secret per
connection; a bare key saved earlier belongs to the service that was selected).
The models page asks for an API type (OpenAI-compatible or Anthropic), then a name,
API address, key and model; an OpenAI-compatible connection to api.openai.com uses
the Responses protocol. Bing RSS and Brave Search API were removed. A saved Bing or Brave choice becomes
Tavily; a Brave key is never sent to another service. Switching the search service
keeps each key. «Проверить поиск» runs one real search and shows the link count
or the exact reason.

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

Planned work (see the README roadmap): structured memory sections,
semantic search, learning from corrections, and device-to-device transfer through
an encrypted copy in the user's own cloud storage — still without a PersAI server.


### Выбор инструментов в диалоге

На первом сообщении предварительная проверка памяти и поиск по прежним правилам
сохраняются как оптимизация. Результат памяти больше не закрывает доступ к интернету.
На продолжении диалога агент получает историю и самостоятельно формулирует запрос
для `search_web`, если данных недостаточно. `search_local_notes`, поиск и чтение
страницы могут последовательно использоваться в одном ходе. Данные возвращаются
модели, которая выбирает следующее действие или отвечает.

`read_web_page` принимает точные ссылки из результатов поиска, найденных заметок,
пользовательских сообщений и прежних источников. Полученные страницы являются
данными, а не инструкциями. Сочинённая моделью ссылка не разрешается автоматически.
В цикле допускаются три поисковых запроса и три чтения; повтор одинакового действия
отклоняется. Общий лимит основной LLM — четыре запроса за сообщение.
