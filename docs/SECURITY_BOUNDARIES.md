# Security boundary hardening: MCP and uploaded file provenance

## MCP
Global `allow_mcp_access` authorizes a client to use the transport, but
is **not** permission to inspect a collection. The owner must separately set
`allow_mcp_access=true` for each classified collection. Unclassified and secret
collections can never be exposed. Tool dispatch runs in an external MCP
scope that revalidates the current grants; unsupported domain tools fail closed.
Revocation blocks subsequent dispatches even if an old client still advertises
cached tools. Cloud LLM permission and MCP permission are independent.

## Uploaded files
A file uploaded by any channel starts **unclassified** and unassigned.
The owner may classify it with
`PUT /v1/privacy/blobs/{blob_id}` and body
`{"collection_slug":"garage","sensitivity":"standard"}`.
Get `blob_id` from `POST /v1/blobs`. Only the authenticated owner may
perform that operation; specifying someone else's collection is rejected.
For remote vision, receipt extraction or embedding a document's full text,
the classified source blob must belong to the **same collection** as the
target; its sensitivity must be `standard`, and that collection must grant
the corresponding egress permission. Collection-wide opt-in does not override
a sensitive/secret/unclassified source. Existing files from earlier versions
remain unclassified until the owner explicitly assigns them.

Local PDF extraction continues to work without cloud grants. Metadata such
as a document filename may still appear in an explicitly selected cloud
chat; future ingress DLP can refine this. No third-party system guarantees
remote erasure of bytes exported before revocation.

## Device-local follow-up
Local SQLCipher still needs on-device owner authorization and native
integration QA; these are separate tasks in the following mobile PR.
