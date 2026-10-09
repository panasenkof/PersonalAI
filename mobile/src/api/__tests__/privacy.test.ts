import { api, configureApi } from "../client";
import type { PrivacyCollection } from "../../types";

test("mobile privacy controls roundtrip owner-scoped API and send explicit flags", async () => {
  configureApi({
    getBase: () => "https://pia.example.com",
    getTokens: () => ({ access_token: "privacy-token", refresh_token: "refresh" }),
    setTokens: async () => {},
  });
  const original = global.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url, init) => {
    seen.push({ url: String(url), init: init as RequestInit });
    if (String(url).endsWith("/v1/privacy/collections")) {
      return { ok: true, status: 200, json: async () => [{
        slug: "garage", sensitivity: "standard", allow_cloud_llm: false,
        allow_remote_embeddings: false, allow_remote_extraction: false,
        allow_messenger_reminders: false,
      }] };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(String((init as RequestInit).body)) };
  }) as typeof fetch;
  try {
    const collections = await api.privacyCollections();
    expect(collections).toHaveLength(1);
    const changed: PrivacyCollection = { ...collections[0], allow_remote_extraction: true };
    await api.savePrivacyCollection(changed);
    await api.savePrivacyHistory({ allow_cloud_history: true });
    await api.savePrivacyIntegrations({ allow_remote_stt: true, allow_mcp_access: false });
    expect(seen.map(x => x.url)).toEqual([
      "https://pia.example.com/v1/privacy/collections",
      "https://pia.example.com/v1/privacy/collections/garage",
      "https://pia.example.com/v1/privacy/conversation",
      "https://pia.example.com/v1/privacy/integrations",
    ]);
    for (const entry of seen) {
      expect((entry.init.headers as Record<string, string>).Authorization).toBe("Bearer privacy-token");
    }
    expect(JSON.parse(String(seen[1].init.body))).toMatchObject({
      slug: "garage", allow_cloud_llm: false, allow_remote_extraction: true,
    });
  } finally { global.fetch = original; }
});
