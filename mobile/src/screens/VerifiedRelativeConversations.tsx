/** R3b2b: explicit person-rooted access to the ONE confirmed graph/search route.
 * Selecting a person is not a durable assertion that this is the profile owner.
 * No name matching, no AI inference, no independent relation reader or decryptor.
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { BottomSheet } from "../components/BottomSheet";
import { localMemoryRepository } from "../local-memory/repository";
import { memoryErrorMessage } from "../local-memory/errors";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import type { MemoryHit } from "../local-memory/types";
import type { DirectPersonRelation } from "../local-memory/relational-proof";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { memoryDisplayTitle } from "../design/nebula/memoryNotePresentation";

const ROLES: ReadonlyArray<{kind: DirectPersonRelation; title: string}> = [
  {kind: "has_sister", title: "Сестра"}, {kind: "has_brother", title: "Брат"},
  {kind: "has_mother", title: "Мама"}, {kind: "has_father", title: "Папа"},
  {kind: "has_spouse", title: "Супруг(а)"}, {kind: "has_friend", title: "Друг"},
  {kind: "has_colleague", title: "Коллега"},
];

export function VerifiedRelativeConversations({ profile, personId, personTitle }: {
  profile: string; personId: string; personTitle: string;
}) {
  const t = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<DirectPersonRelation | null>(null);
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    generation.current++;
    setOpen(false); setRole(null); setHits(null); setBusy(false); setError("");
  }
  useEffect(() => {
    const off = onLocalMemorySessionChange(unlocked => { if (!unlocked) reset(); });
    return () => { generation.current++; off(); };
  }, []);
  useEffect(() => {
    generation.current++; setOpen(false); setRole(null); setHits(null); setBusy(false); setError("");
  }, [profile, personId]);

  async function search(kind: DirectPersonRelation) {
    const current = ++generation.current;
    setRole(kind); setHits(null); setBusy(true); setError("");
    try {
      const db = await localMemoryRepository(profile);
      const person = await db.entity(personId);
      if (!person || person.kind !== "person" || person.record_status !== "active")
        throw new Error("Выбранная запись человека больше не доступна.");
      const rows = await db.searchMemory("Разговоры с родственниками и знакомыми", {
        verifiedRelative: {ownerPersonId: personId, relationKind: kind}, limit: 20,
      });
      if (current === generation.current) setHits(rows.filter(hit => Boolean(hit.proof)));
    } catch (e) {
      if (current === generation.current) setError(memoryErrorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function openHit(hit: MemoryHit) {
    if (!role || busy || !hit.proof) return;
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      // Search again when selected: a source edit/retraction after the preview
      // must not take a user to an unrelated original or stale proof.
      const db = await localMemoryRepository(profile);
      const fresh = await db.searchMemory("Разговоры с родственниками и знакомыми", {
        verifiedRelative: {ownerPersonId: personId, relationKind: role}, limit: 20,
      });
      const verified = fresh.find(row =>
        row.entity.id === hit.entity.id &&
        row.entity.record_version === hit.entity.record_version &&
        row.proof?.relativeId === hit.proof?.relativeId &&
        row.proof?.relationEvidenceId === hit.proof?.relationEvidenceId &&
        row.proof?.participantEvidenceId === hit.proof?.participantEvidenceId);
      if (!verified) throw new Error("Связь или источник изменились. Повторите поиск.");
      if (current !== generation.current) return;
      const original = verified.originals?.find(item => item.kind === "audio") || verified.originals?.[0];
      reset();
      navigation.navigate("MemoryNote", {
        entityId: verified.entity.id,
        ...(original ? {verifiedOriginal: original} : {}),
      });
    } catch (e) {
      if (current === generation.current) setError(memoryErrorMessage(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  const action = {minHeight: nebulaTouch.minimum, padding: nebulaSpacing.md,
    borderWidth: 1, borderColor: t.line, borderRadius: nebulaRadii.field};
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Найти подтверждённые разговоры по связям"
      onPress={() => setOpen(true)} style={action}>
      <Text style={{ color: t.secondary, fontWeight: "700" }}>Разговоры по подтверждённым связям</Text>
    </Pressable>
    <BottomSheet visible={open} title="Найти разговоры по связям" onClose={reset}>
      <Text style={{color: t.text}}>Исходная персона: {personTitle}. Поиск ведётся от выбранной записи, а не от автоматически угаданного владельца профиля.</Text>
      <Text style={{color: t.muted}}>Выберите отношение. Только подтверждённое участие в разговоре считается совпадением; простого упоминания недостаточно.</Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.sm}}>
        {ROLES.map(item => <Pressable key={item.kind} accessibilityRole="button"
          accessibilityLabel={"Искать разговоры: "+item.title}
          accessibilityState={{selected:role===item.kind,disabled:busy}} disabled={busy}
          onPress={() => void search(item.kind)}
          style={{...action,backgroundColor:role===item.kind?t.soft:t.panel}}>
          <Text style={{color:t.text}}>{item.title}</Text>
        </Pressable>)}
      </View>
      {busy ? <ActivityIndicator accessibilityLabel="Проверяю доказательства разговоров" /> : null}
      {error ? <Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text> : null}
      {hits?.length===0 ? <Text style={{color:t.muted}}>Подтверждённых разговоров в доступной части памяти не найдено. Это не означает, что упоминаний или записей нет.</Text> : null}
      {hits?.map(hit => <Pressable key={hit.entity.id + ":" + hit.proof?.relativeId} accessibilityRole="button"
        accessibilityLabel={"Открыть подтверждённый разговор "+memoryDisplayTitle(hit.entity)}
        disabled={busy} onPress={() => void openHit(hit)}
        style={action}>
        <Text style={{color:t.text,fontWeight:"700"}}>{memoryDisplayTitle(hit.entity)}</Text>
        <Text style={{color:t.muted}}>Подтверждены отношение и участие · {hit.originals?.length ? "есть доступный оригинал" : "оригинал не подтверждён"}</Text>
        {hit.chunk ? <Text numberOfLines={2} style={{color:t.muted}}>{hit.chunk}</Text> : null}
      </Pressable>)}
      {hits?.some(hit=>hit.proof?.truncated) ? <Text style={{color:t.muted}}>Показана только часть подтверждённых результатов; это не полный список.</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть поиск разговоров" onPress={reset} style={action}>
        <Text style={{color:t.secondary}}>Закрыть</Text>
      </Pressable>
    </BottomSheet>
  </>;
}
