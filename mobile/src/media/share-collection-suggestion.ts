import type { CollectionRecord } from "../local-memory/types";

/** MSG-6.C1 — read-only hint for the existing Android Share draft.
 * The sender's text is UNTRUSTED: it cannot select a collection, change ACL,
 * send content to a provider, or persist metadata without a user tap.
 * Hashtags stay ordinary note-body text until the canonical tags contract exists.
 */
export type IncomingCollectionHint = {
  collectionId: string;
  name: string;
  reason: string;
  evidence: "hashtag" | "text";
};

function normalizedWords(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").match(/[\p{L}\p{N}]+/gu)?.join(" ") || "";
}
function compact(value: string): string {
  return normalizedWords(value).replace(/ /g, "");
}

export function suggestIncomingCollection(
  caption: string, collections: readonly Pick<CollectionRecord, "id" | "name" | "slug" | "sensitivity">[],
): IncomingCollectionHint | null {
  if (!caption || caption.length > 60_000) return null;

  // Do not derive tags from URL fragments or untrusted remote query strings.
  const text = caption.replace(/https?:\/\/\S+/giu, " ");
  const tags = [...text.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_-]{2,40})/gu)]
    .map(x => ({ raw: "#" + x[1], key: compact(x[1]) }));
  const options = collections.filter(c => c.id && c.name.trim() &&
    c.sensitivity === "standard" && !["notes", "inbox"].includes(c.slug));
  const hashtagMatches = options.flatMap(c => {
    const tag = tags.find(x => x.key === compact(c.name) || x.key === compact(c.slug));
    return tag ? [{ collection: c, reason: "по отметке " + tag.raw }] : [];
  });

  // Ambiguous tags must not secretly pick a winner.
  if (hashtagMatches.length > 1) return null;
  if (hashtagMatches.length === 1) {
    const { collection, reason } = hashtagMatches[0];
    return { collectionId: collection.id, name: collection.name, reason, evidence: "hashtag" };
  }

  const normalizedText = " " + normalizedWords(text) + " ";
  const contentMatches = options.filter(c => {
    const name = normalizedWords(c.name);
    // A small generic word is not sufficiently strong evidence.
    return name.length >= 4 && normalizedText.includes(" " + name + " ");
  });
  if (contentMatches.length !== 1) return null;
  const collection = contentMatches[0];
  return {
    collectionId: collection.id, name: collection.name,
    reason: "название раздела встречается в подписи", evidence: "text",
  };
}
