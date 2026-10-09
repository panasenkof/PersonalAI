# Attachments: explicit classification in chat

A file upload does not grant cloud access. The server records it as
`unclassified` with no collection provenance. Existing files from before the
migration remain unclassified too.

The mobile and web chat now allow the owner to select a **classified**
collection (for example `garage` or `health`) and choose a per-file
sensitivity. The default is **sensitive**, not cloud-accessible; changing a
selection does nothing until the owner explicitly presses **Save
classification**. The operation calls the authenticated
`PUT /v1/privacy/blobs/{blob_id}` endpoint. An error leaves the file
unclassified or keeps the last successfully saved classification.

- **Sensitive/secret**: no cloud extraction or embeddings.
- **Standard**: cloud extraction/embeddings only when the *collection* has
  separately granted that capability in Privacy Settings.
- **No classification**: local handling remains available; the external
  processing of the blob is blocked.
- A document's filename and storage key may still be included in prompts
  that use an external LLM; these metadata are not the document's contents.

This is not a promise that changing permission can delete data already
delivered to a third-party provider. Additional release QA should validate
actual user understanding of egress permissions.
