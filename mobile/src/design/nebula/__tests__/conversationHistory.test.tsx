import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import type { LiveConversation } from "../../../direct-agent/chat-store";
import { indexConversationHistory, searchConversationHistory } from "../conversationHistory";
import { ConversationHistorySheet } from "../ConversationHistorySheet";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../../theme", () => ({
  useTheme: () => ({
    muted: "#adb3d3", line: "#32365a", soft: "#252a4f", text: "#ffffff",
    accent: "#a49bff", panel: "#191c39", err: "#ff8ead",
  }),
}));
jest.mock("../../../components/BottomSheet", () => ({
  BottomSheet: ({ visible, title, children }: { visible: boolean; title: string; children: React.ReactNode }) => {
    const React = require("react");
    const { View, Text } = require("react-native");
    return visible ? React.createElement(View, null, React.createElement(Text, null, title), children) : null;
  },
}));

function chat(id: string, title = "Диалог", updatedAt = "2026-10-22T10:00:00Z",
  text = "", busy = false): LiveConversation {
  return {
    id, title, updatedAt, createdAt: updatedAt, question: "", drafts: [],
    rows: text ? [{ id: `message-${id}`, role: "user", text }] : [],
    busy, progress: "",
  };
}

describe("Conversation history presentation", () => {
  it("sorts latest first, has a safe preview, and does not mutate the store array", () => {
    const older = chat("old", "Заметки", "2026-10-21T00:00:00Z", "Первая строка\nвторая");
    const newer = chat("new", "Рабочее", "2026-10-23T00:00:00Z");
    const original = [older, newer];
    const indexed = indexConversationHistory(original);
    expect(indexed.map(row => row.conversation.id)).toEqual(["new", "old"]);
    expect(indexed[0].preview).toBe("Пока нет сообщений");
    expect(indexed[1].preview).toBe("Первая строка вторая");
    expect(original.map(row => row.id)).toEqual(["old", "new"]);
  });
  it("searches Russian titles and message bodies independent of case and word order", () => {
    const indexed = indexConversationHistory([
      chat("a", "Планы", undefined, "Купить подарок учителю ко дню рождения"),
      chat("b", "Рецепты", undefined, "Тыквенный суп"),
    ]);
    expect(searchConversationHistory(indexed, "  УЧИТЕЛЮ   подарок ").map(x => x.conversation.id)).toEqual(["a"]);
    expect(searchConversationHistory(indexed, "рецепты суп").map(x => x.conversation.id)).toEqual(["b"]);
    expect(searchConversationHistory(indexed, "нет такого")).toEqual([]);
    expect(searchConversationHistory(indexed, "  ")).toHaveLength(2);
  });
  it("shows no-result help, lets the user clear search and open the selected chat", () => {
    const select = jest.fn();
    const close = jest.fn();
    const view = render(<ConversationHistorySheet visible conversations={[chat("a", "Семья", undefined, "Праздник")]}
      activeId="a" onClose={close} onSelect={select} onDelete={jest.fn()} onNewChat={jest.fn()} />);
    expect(view.getByText("Диалогов: 1")).toBeTruthy();
    fireEvent.changeText(view.getByLabelText("Поиск диалогов"), "неизвестное");
    expect(view.getByText("Ничего не найдено")).toBeTruthy();
    expect(view.getByText("Найдено диалогов: 0")).toBeTruthy();
    fireEvent.press(view.getByLabelText("Очистить поиск диалогов"));
    fireEvent.press(view.getByLabelText("Открыть диалог Семья"));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(close).not.toHaveBeenCalled(); // Parent closes after selection.
  });
  it("pages a large history, blocks deletion of a running chat, resets its query when closed", () => {
    const chats = Array.from({ length: 65 }, (_, i) => chat(String(i), `Диалог ${i}`, undefined, "", i === 0));
    const onDelete = jest.fn();
    const props = { conversations: chats, activeId: null, onClose: jest.fn(), onSelect: jest.fn(), onDelete, onNewChat: jest.fn() };
    const view = render(<ConversationHistorySheet visible {...props} />);
    expect(view.getAllByTestId(/chat-history-item-/)).toHaveLength(30);
    expect(view.getByLabelText("Удалить диалог Диалог 0").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(view.getByLabelText("Показать ещё диалоги"));
    expect(view.getAllByTestId(/chat-history-item-/)).toHaveLength(60);
    fireEvent.changeText(view.getByLabelText("Поиск диалогов"), "Диалог 64");
    expect(view.getAllByTestId(/chat-history-item-/)).toHaveLength(1);
    view.rerender(<ConversationHistorySheet visible={false} {...props} />);
    view.rerender(<ConversationHistorySheet visible {...props} />);
    expect(view.getByText("Диалогов: 65")).toBeTruthy();
    expect(view.getAllByTestId(/chat-history-item-/)).toHaveLength(30);
    expect(onDelete).not.toHaveBeenCalled();
  });
  it("keeps the row icons compact but framed and the new-chat action visible", () => {
    const onDelete=jest.fn();
    const onNewChat=jest.fn();
    const conversation=chat("a","Заметки");
    const view=render(<ConversationHistorySheet visible conversations={[conversation]}
      onClose={jest.fn()} onSelect={jest.fn()} onDelete={onDelete}
      onNewChat={onNewChat} onSummary={jest.fn()}/>);
    const summary=view.getByLabelText("Сохранить итог диалога Заметки");
    const remove=view.getByLabelText("Удалить диалог Заметки");
    for (const iconAction of [summary, remove]) {
      expect(iconAction.props.style.minHeight).toBeGreaterThanOrEqual(48);
      expect(iconAction.props.style.borderWidth).toBe(1);
      expect(iconAction.props.style.backgroundColor).toBeTruthy();
    }
    const create=view.getByLabelText("Создать новый диалог");
    const style=typeof create.props.style==="function"
      ? create.props.style({pressed:false}):create.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.borderWidth).toBe(1);
    fireEvent.press(create);
    expect(onNewChat).toHaveBeenCalledTimes(1);
    fireEvent.press(remove);
    expect(onDelete).toHaveBeenCalledWith(conversation);
  });
  it("offers a single accessible opt-in summary action, disabled while the chat runs", () => {
    const onSummary=jest.fn();
    const free=chat("free","Рабочая переписка");
    const busy=chat("busy","Диалог занят",undefined,"",true);
    const view=render(<ConversationHistorySheet visible conversations={[free,busy]}
      onClose={jest.fn()} onSelect={jest.fn()} onDelete={jest.fn()} onNewChat={jest.fn()}
      onSummary={onSummary}/>);
    expect(view.getByLabelText("Сохранить итог диалога Диалог занят").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(view.getByLabelText("Сохранить итог диалога Рабочая переписка"));
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledWith(expect.objectContaining({id:"free"}));
  });

});

test("history: topic transitions remain searchable under both old and new sections",()=>{
  const c=chat("mixed","Диалог");
  c.context={topic:"Лазанья",sectionSlug:"recipes",pinned:false};
  c.rows=[
    {id:"q1",role:"user",text:"Поставить аккумулятор"},
    {id:"a1",role:"assistant",text:"Проверьте ёмкость",contextChange:{
      topic:"Аккумулятор",sectionSlug:"cars",previousTopic:null,previousSectionSlug:null,
      sectionName:"Авто",previousSectionName:null,reason:"Обсуждение автомобиля",at:"2026-11-07T18:01:00Z"}},
    {id:"q2",role:"user",text:"Как приготовить лазанью?"},
    {id:"a2",role:"assistant",text:"Используйте соус",contextChange:{
      topic:"Лазанья",sectionSlug:"recipes",previousTopic:"Аккумулятор",previousSectionSlug:"cars",
      sectionName:"Рецепты",previousSectionName:"Авто",reason:"Новая тема",at:"2026-11-07T18:05:00Z"}},
  ];
  const index=indexConversationHistory([c]);
  expect(searchConversationHistory(index,"аккумулятор","cars")).toHaveLength(1);
  expect(searchConversationHistory(index,"лазанья","recipes")).toHaveLength(1);
  expect(searchConversationHistory(index,"","cars")).toHaveLength(1);
  expect(searchConversationHistory(index,"","work")).toHaveLength(0);
  const ui=render(<ConversationHistorySheet visible conversations={[c]} activeId="mixed"
    onClose={jest.fn()} onSelect={jest.fn()} onDelete={jest.fn()} onNewChat={jest.fn()} />);
  expect(ui.getByLabelText("Фильтр: Авто")).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Фильтр: Авто"));
  expect(ui.getByText("Найдено диалогов: 1")).toBeTruthy();
  expect(ui.getByText("Тема: Лазанья")).toBeTruthy();
});
