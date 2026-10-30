# №83.0 · Local photo search — baseline and bounded next step

## Why

PersAI's current on-device semantic model embeds **text chunks** (MiniLM 384d).
Original images live in SQLCipher, but their pixels are **not** indexed for
semantic retrieval. An image note without user caption, OCR or title keywords
must not be misrepresented as a visual search hit.

## Existing authority and boundaries

- `memory_entities` and `memory_attachments/memory_attachment_parts` contain
  user-owned notes and encrypted originals; 10 originals/80 MiB per note.
- `memory_search_fts`, `memory_chunks`, `memory_vectors` and
  `memory_vector_jobs` are **derived**, rebuildable data; `memory_aliases`,
  manual `memory_index_terms`, extraction evidence and verified links are NOT.
- Canonical note search is `SqliteMemoryRepository.searchMemory`; cloud
  assistants additionally use their authorized `searchApprovedNotes/readApprovedNote`.
  The verified original read must repeat ACL/source/version validation.
- Existing MiniLM vectors must **never** be compared directly with
  EmbeddingGemma 2 vectors. Use a new versioned embedding space if adopted.
- No photo bytes, embeddings, model diagnostics or user filenames leave
  the device by default. AppLock/profile switch must stop inference and clear
  temporary plaintext. No cloud fallback for visual embeddings.

## 83.0 reproducible baseline

`mobile/src/local-memory/__tests__/photo-baseline.test.ts` runs **actual SQLite**
under Jest, testing existing search and status/visibility rules:

1. An original-only image note (`IMG_0001.jpg`) is found by filename but
   **not** by a hidden object concept like “велосипед”.
2. A text-captioned note with “велосипед” is found by FTS; manually adding
   that word to the uncaptioned note makes it findable **by text only**.
3. `reindexAll` does not hallucinate visual labels.
4. Scoped queries exclude private and archived notes.

Synthetic byte placeholders are deliberately **not valid image
embeddings**. These tests prove safety and expose the missing capability;
they are NOT Recall@K, model quality, Android speed or a working photo search.

## 83.1 isolated Android spike (next PR, no rollout)

Use the official Android MediaPipe Universal Embedder API
(`com.google.mediapipe:tasks-retrieval`) backed by LiteRT-LM, starting with
the 440M Text-Vision model. Pin a verified dependency version; never use
`latest.release` in production. Build a separate Expo native module with
a guarded/opt-in laboratory interface, and do **not** modify SQLCipher
schema, the memory UI, the regular FTS/MiniLM index or ChatGPT/LLM tools.

The next PR must prove that the bridge can open the verified local
`.litertlm` model, embed one **real** image and a Russian text query
offline, and close/unload without leaving private bitmaps or plaintext.
Provide testable status `unsupported / absent / ready / error`, no silent
model download, fail closed on missing model, record SHA-256/model revision,
dimension, normalization, delegate/ABI/OS and total memory. Keep model
weights out of Git and native CI (unless explicitly running the gated
benchmark). Do not promise native support before the actual Android result.

## 83.2+ go/no-go

Test **real** labeled photos: text→image and image→image (different
angles), near-identical-but-different cars, identifiers/OCR, Russian
queries, one note with multiple originals, deleted and private items,
rollback/restore, blocked app and no model installed. Measure
Recall@1/5, false identity claims, latency p50/p95, peak RAM, APK/storage,
heat and battery. Only then add a derivative photo index in SQLCipher and
fuse with the existing authorized search. OCR of exact numbers is a
different task; cosine similarity is never identity proof.

## Reference check — 30 October 2026

- Official Android task:
  https://developers.google.com/edge/mediapipe/solutions/retrieval/universal_embedder/android
- Task overview and supported models:
  https://developers.google.com/edge/mediapipe/solutions/retrieval/universal_embedder
- PersAI plan: `Plans/LOCAL_MULTIMODAL_AI.md`, part 83.
- **Accepted:** local-only inference, separate model space, image/text
  embedding methods, bounded Android-native spike.
- **Deferred:** model download in default app, new persistent schema,
  untested OCR/video/audio, automatic web/LLM image upload.
