from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

MAX_DOC_CHARS = 200_000


def extract_pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 — skip broken pages
            logger.warning("pdf page extraction failed")
    return "\n".join(parts).strip()


def extract_document_text(data: bytes, mime: str, filename: str | None = None) -> str:
    """Best-effort plain text of a PDF / text-like file (empty string when unsupported)."""
    name = (filename or "").lower()
    mime = (mime or "").lower()
    if "pdf" in mime or name.endswith(".pdf"):
        return extract_pdf_text(data)[:MAX_DOC_CHARS]
    if mime.startswith("text/") or mime in ("application/json", "application/xml") or name.endswith(
        (".txt", ".md", ".csv", ".json")
    ):
        return data.decode("utf-8", errors="replace")[:MAX_DOC_CHARS]
    return ""
