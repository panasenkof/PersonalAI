# Evidence: memory architecture audit, 26.10.2026

Code: main `b1a2b3b31aa4a2ece88e25705207914307fc4c14`. Node v24.22.1, project Jest/Expo preset; in-memory Node SQLite FTS5; synthetic data only. No network LLM request, native embedding, Android, SQLCipher performance or physical storage was tested. Production application code was not modified.

Command (from repository root; a temporary test is removed after running):

```bash
cp docs/architecture/memory-audit-20261026.probe.ts mobile/eval/__tests__/memory-audit.temp.test.ts
npm --prefix mobile test -- --runInBand eval/__tests__/memory-eval.test.ts eval/__tests__/memory-audit.temp.test.ts
rm mobile/eval/__tests__/memory-audit.temp.test.ts
```

Result: **2 suites / 9 tests passed, 4.474 s**. Seven audit probes intentionally confirm current shortcomings; a future fix should change those historical expectations. They are saved outside the normal test discovery path, not made a permanent CI gate requiring defects to survive. During implementation, convert the relevant example to a regression test of the correct behavior.

| Probe | Observed result |
|---|---|
| M02: payload.city, source_files, observation.payload.text | Stored values cannot be found by searchMemory |
| M05: valid_until=2020-01-01 | Active note is returned; temporal metadata absent from model snippet |
| M03: discriminating term after 120 characters | Direct term finds note; same term at end of longer question does not |
| M05: «Квитанция холодильника» against «Квитанция за ремонт холодильника» | Library phrase search: 0; assistant word search: 1 |
| M10: edit note while enrichment response is pending | Old occupation terms saved on new occupation; record NOT marked stale |
| M10: note only has extracted_text | FTS finds text; enrichment request omits it |
| M04: 200 chunks, request pending batch=16 | SQL adapter transfers 200 rows to JS, then returns 16 |

## Existing 39-question lexical baseline

25 synthetic notes. Success means at least one expected note in top5, not complete answer correctness. No deviceEmbedder: passing a repository explicitly disables it in searchApprovedNotes.

| Category | No model terms | Fixed fixture model terms |
|---|---:|---:|
| Forms | 14/14 | 14/14 |
| Synonyms | 3/8 | 8/8 |
| Through a person | 5/6 | 6/6 |
| Semantic phrasing (category name, not native semantic test) | 4/6 | 6/6 |
| Absent | 3/3 | 3/3 |
| Private excluded | 2/2 | 2/2 |
| Unnecessary initial web search after expected hit | 0 | 0 |

No-terms misses: «Какой у меня автомобиль?», «Какое кино мне нравится?», «Какой напиток я предпочитаю?», «Когда ТО машины?» (car found, service missing), «Как зовут моего шефа?», «Как зовут мою племянницу?», «Что не стоит готовить мне на ужин?», «Как мне лучше писать ответы?».

The fixture terms are prescribed mock model answers. Their 100% result shows that enrichment can help on these fixtures, not the production accuracy of a real model. No large-volume latency numbers were measured. Complexity/storage estimates in the audit are explicitly analytical.
