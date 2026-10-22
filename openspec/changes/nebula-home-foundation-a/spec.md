# Native Home phase A — минимальная миграция

**Источник требований:** [Nebula Home v0.3](../../../docs/design/NEBULA_PRODUCTION_ROLLOUT.md), [source UX audit](../../../docs/design/NEBULA_HOME_UX_AUDIT_2026-10-22.md) и художественно утверждённая [B+C сфера](../../../docs/design/NEBULA_DUAL_SPEED_THINKING.md).

## Требования
1. `HomeScreen` SHALL render a single row `NebulaHomeHeader`: PersAI, short selected model, history, new chat, all accessible and touch >=48dp.
2. Empty-state SHALL render the original approved **REF-ORB-B asset**, not a primitive circle or a fabricated CSS approximation. Large hero `Чем помочь сегодня?`, four prompt suggestions and explanation billboard SHALL disappear.
3. If model connection is missing, first-run setup guide and provider presets SHALL remain reachable and functional. The user must not be stranded in an empty blank chat.
4. Voice, normalization, send/stop, streaming, chat history, memory proposal/links, config navigation, biometric/access control remain untouched.
5. User-selected Android system IME SHALL open via native `PromptInput<TextInput>`. No hardcoded keyboard, keyboard screenshots, alternative input engine or ad-hoc keyboard simulation.
6. Until measured on Android, render the high-fidelity approved still; **no premature production Skia 60fps loop**. Full performance testing follows native integration of core/sky/streaming/voice.
7. Automated browser acceptance and Jest should continue to pass. Device-level input inset/TalkBack screenshots marked **NOT RUN** until tested.

## WHEN/THEN

WHEN chat contains no conversation AND LLM is configured THEN approved sphere is the only hero and composer remains active.  
WHEN chat already has rows THEN standard `FlatList` and draft/busy/stream flow remain.  
WHEN new chat/history/model actions are tapped THEN existing callbacks and navigation routes execute.  
WHEN first-run needs model THEN setup guide still offers presets and model selection.  
WHEN user focuses prompt THEN **only Android system keyboard** is involved and app continues to use original `TextInput`.
