/** ARCH-4: one chat card for every explicit user-confirmed proposal.
 * All actions are callbacks into DirectChatStore; this component cannot write
 * memory or bypass ACL/version checks. Styling mirrors the legacy two cards.
 */
import React from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, Text, View } from "react-native";
import { NebulaAction } from "../design/nebula/components";
import type { ChatRow } from "../direct-agent/conversations";
import { rowProposal, rowReceipt, type ProposalCardView, type ProposalKind, type ReceiptView } from "../direct-agent/proposals";
import { useTheme } from "../theme";

export function ProposalCard({ view, busy, working, onConfirm, onDismiss, onOpenNote }: {
  view: ProposalCardView;
  busy: boolean;
  working: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onOpenNote: (id: string) => void;
}) {
  const t = useTheme();
  const move = Boolean(view.openNoteId);
  return <View style={{
    borderWidth: 1, borderColor: t.line, borderRadius: 16,
    padding: 12, backgroundColor: t.panel, gap: 8,
  }}>
    <Text style={{ color: t.text, fontWeight: "700" }}>{view.heading}</Text>
    {move && view.openNoteId ? <Pressable
      accessibilityRole="link"
      accessibilityLabel={"Открыть запись " + (view.lines[0] || "")}
      onPress={() => onOpenNote(view.openNoteId!)}
      style={{ minHeight: 40, justifyContent: "center" }}>
      <Text style={{ color: t.accent, fontWeight: "600" }}>{view.lines[0]}</Text>
    </Pressable> : <Text style={{ color: t.text }}>{view.lines[0]}</Text>}
    {view.lines.slice(1).map((line, index) =>
      <Text key={index} style={index === 0 && move
        ? { color: t.text }
        : { color: t.muted, fontSize: 12 }}>{line}</Text>)}
    {view.note ? <Text style={{ color: t.muted, fontSize: 12 }}>{view.note}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NebulaAction
        icon={view.confirmIcon as React.ComponentProps<typeof Feather>["name"]}
        variant={view.danger ? "danger" : "primary"}
        label={working ? (move ? "Переношу…" : "Проверяю…") : view.confirmLabel}
        disabled={busy} onPress={onConfirm} />
      <NebulaAction icon="x" label="Отмена" size="compact"
        disabled={busy} onPress={onDismiss} />
    </View>
  </View>;
}

export function ReceiptLine({ view, kind, busy, working, onUndo }: {
  view: ReceiptView;
  kind: ProposalKind;
  busy: boolean;
  working: boolean;
  onUndo: () => void;
}) {
  const t = useTheme();
  const [heading, ...details] = view.text.split("\n");
  return <View style={{
    borderWidth: 1, borderColor: t.line, borderRadius: 16,
    padding: 12, backgroundColor: t.panel, gap: kind === "section" ? 4 : 8,
  }}>
    <Text style={{ color: t.text, fontWeight: "700" }}>{heading}</Text>
    {details.map((line, index) => <Text key={index} style={{ color: t.muted }}>{line}</Text>)}
    {view.undoable && !view.undone ?
      <NebulaAction icon="rotate-ccw" label={working ? "Отмена…" : "Отменить перенос"}
        size="compact" disabled={busy} onPress={onUndo} /> : null}
  </View>;
}


/** One entry point for both persisted proposal kinds in every assistant row. */
export function ChatProposalCards({ row, busy, working, onConfirm, onDismiss, onUndo, onOpenNote }: {
  row: ChatRow;
  busy: boolean;
  working: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onOpenNote: (id: string) => void;
}) {
  const proposed = rowProposal(row);
  const receipt = rowReceipt(row);
  return <>
    {row.inboxApproval ? <ProposalCard
      view={{heading:"Разрешить разбор «Входящих»?",
        lines:[row.inboxApproval.label],
        note:"После подтверждения выбранной модели будет передано не более "+row.inboxApproval.limit+" записей: заголовок, до 600 символов текста и теги каждой. Без вашего согласия записи не читаются. Сейчас никаких изменений в памяти не выполняется.",
        confirmLabel:"Разрешить разбор",confirmIcon:"check",danger:false}}
      busy={busy} working={working} onConfirm={onConfirm} onDismiss={onDismiss}
      onOpenNote={onOpenNote} /> : null}
    {proposed ? <ProposalCard view={proposed.handler.present(proposed.proposal)}
      busy={busy} working={working} onConfirm={onConfirm}
      onDismiss={onDismiss} onOpenNote={onOpenNote} /> : null}
    {receipt ? <ReceiptLine view={receipt.handler.presentReceipt(receipt.receipt)}
      kind={receipt.handler.kind} busy={busy} working={working} onUndo={onUndo} /> : null}
  </>;
}
