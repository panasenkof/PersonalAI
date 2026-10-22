import { readFileSync } from "node:fs";
import { join } from "node:path";

const document = readFileSync(
  join(__dirname, "..", "..", "..", "docs", "prototypes", "nebula-home-composition-v03.html"), "utf8"
);

describe("Nebula Home composition prototype acceptance", () => {
  it("keeps the authentic orb reference as a linked art asset, never invents a flat circle", () => {
    expect(document).toContain("../../mobile/src/design/nebula/assets/nebula-orb-ref-b.png");
    expect(document).toContain("REF-ORB-B");
    expect(document).not.toContain("fetch(");
    expect(document).not.toContain("XMLHttpRequest");
  });
  it("supports new chat, real chat layout, assistant status and future attachment UX", () => {
    for (const phase of ['data-scenario="empty"', 'data-scenario="chat"', 'data-scenario="thinking"']) {
      expect(document).toContain(phase);
    }
    for (const action of ['id="plus"', 'id="prompt"', 'id="mic"', 'id="send"', 'id="files"']) {
      expect(document).toContain(action);
    }
    expect(document).toContain("Демонстрация, не отправлено");
    expect(document).toContain("id=\"historyList\"");
  });
  it("shows layout test widths and simulated Android keyboard without a real mic/LLM connection", () => {
    for (const width of ["320", "360", "390", "430"]) expect(document).toContain('value="' + width + '"');
    expect(document).toContain("id=\"keyboard\"");
    expect(document).toContain("Демо: макет не записывает звук");
    expect(document).toContain('aria-label="Сообщение"');
    expect(document).toContain('aria-label="Прикрепить файл"');
  });
  it("contains valid standalone prototype JavaScript", () => {
    const match = document.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(() => new Function(match![1])).not.toThrow();
  });
});
