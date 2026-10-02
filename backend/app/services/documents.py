from __future__ import annotations

import io

MAX_DOC_CHARS = 200_000
MAX_PDF_PAGES = 200


class DocumentExtractionError(ValueError):
    """An input cannot be completely and safely extracted within the document budget."""


def extract_pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        if len(reader.pages) > MAX_PDF_PAGES:
            raise DocumentExtractionError("pdf_page_limit_exceeded")
        parts: list[str] = []
        total = 0
        for page in reader.pages:
            text = page.extract_text() or ""
            total += len(text) + 1
            if total > MAX_DOC_CHARS:
                raise DocumentExtractionError("document_character_limit_exceeded")
            parts.append(text)
        return "\n".join(parts).strip()
    except DocumentExtractionError:
        raise
    except Exception as exc:
        raise DocumentExtractionError("pdf_extraction_failed") from exc


def extract_document_text(data: bytes, mime: str, filename: str | None = None) -> str:
    """Complete text extraction, or an explicit error; never silently return a prefix."""
    name = (filename or "").lower()
    mime = (mime or "").lower()
    if "pdf" in mime or name.endswith(".pdf"):
        return extract_pdf_text(data)
    if mime.startswith("text/") or mime in ("application/json", "application/xml") or name.endswith(
        (".txt", ".md", ".csv", ".json")
    ):
        text = data.decode("utf-8", errors="replace")
        if len(text) > MAX_DOC_CHARS:
            raise DocumentExtractionError("document_character_limit_exceeded")
        return text
    return ""
