package expo.modules.persaipdf

import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.ext.SdkExtensions
import java.io.File
import java.io.IOException

/**
 * Android's own PDF text layer; there is no bundled PDF parser or network
 * request. API 35+ uses PdfRenderer, Android 12-14 only when S Extensions
 * v13+ exposes PdfRendererPreV.getTextContents(). Never infer page numbers.
 */
internal object PdfTextPageReader {
  fun isSupported(): Boolean =
    Build.VERSION.SDK_INT >= 35 ||
      (Build.VERSION.SDK_INT >= 31 &&
        SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= 13)

  fun read(file: File, pageLimit: Int): Map<String, Any> {
    require(isSupported()) { "pdf_text_layer_unavailable_on_device" }
    require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
    require(file.isFile && file.length() in 1..(80L * 1024L * 1024L)) {
      "pdf_file_unavailable_or_too_large"
    }

    // Read from a seekable file descriptor. Both platform renderers release
    // pages and descriptors even when a PDF is malformed or over the limit.
    try {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      if (Build.VERSION.SDK_INT >= 35) {
        PdfRenderer(fd).use { pdf ->
          return collect(pdf.pageCount, pageLimit) { index ->
            pdf.openPage(index).use { page ->
              page.textContents.joinToString("\n") { it.text }
            }
          }
        }
      }
      PdfRendererPreV(fd).use { pdf ->
        return collect(pdf.pageCount, pageLimit) { index ->
          pdf.openPage(index).use { page ->
            page.textContents.joinToString("\n") { it.text }
          }
        }
      }
    }
    } catch (e: SecurityException) {
      throw IllegalArgumentException("pdf_password_or_permission_required", e)
    } catch (e: IOException) {
      throw IllegalArgumentException("pdf_corrupt_or_unreadable", e)
    }
  }

  /** H-DOC1b: a bounded window of *actual* native PDF pages.
   * Unlike read(), this does not require total pageCount <= 128.
   * Scanned pages count as visited, but never yield invented text.
   */
  fun readRange(file: File, firstPage: Int, count: Int): Map<String, Any> {
    require(isSupported()) { "pdf_text_layer_unavailable_on_device" }
    require(firstPage >= 1 && count in 1..16) { "invalid_pdf_page_window" }
    require(file.isFile && file.length() in 1..(80L * 1024L * 1024L)) {
      "pdf_file_unavailable_or_too_large"
    }
    try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        if (Build.VERSION.SDK_INT >= 35) {
          PdfRenderer(fd).use { pdf ->
            return collectRange(pdf.pageCount, firstPage, count) { index ->
              pdf.openPage(index).use { page ->
                page.textContents.joinToString("\\n") { it.text }
              }
            }
          }
        }
        PdfRendererPreV(fd).use { pdf ->
          return collectRange(pdf.pageCount, firstPage, count) { index ->
            pdf.openPage(index).use { page ->
              page.textContents.joinToString("\\n") { it.text }
            }
          }
        }
      }
    } catch (e: SecurityException) {
      throw IllegalArgumentException("pdf_password_or_permission_required", e)
    } catch (e: IOException) {
      throw IllegalArgumentException("pdf_corrupt_or_unreadable", e)
    }
  }

  private fun collectRange(
    totalPages: Int,
    firstPage: Int,
    requested: Int,
    textAt: (index: Int) -> String,
  ): Map<String, Any> {
    require(totalPages > 0 && firstPage <= totalPages) { "invalid_pdf_page_window" }
    val endExclusive = minOf(totalPages, firstPage - 1 + requested)
    var chars = 0
    val pages = mutableListOf<Map<String, Any>>()
    for (index in firstPage - 1 until endExclusive) {
      val text = textAt(index).trim()
      chars += text.length
      require(chars <= 128_000) { "pdf_page_window_text_limit_exceeded" }
      if (text.isNotEmpty()) pages.add(mapOf("page" to index + 1, "text" to text))
    }
    return mapOf(
      "pageCount" to totalPages,
      "firstPage" to firstPage,
      "processedPageCount" to (endExclusive - firstPage + 1),
      "pages" to pages,
    )
  }

  private fun collect(
    count: Int,
    pageLimit: Int,
    textAt: (index: Int) -> String,
  ): Map<String, Any> {
    require(count in 1..pageLimit) { "pdf_page_limit_exceeded" }
    var total = 0
    val pages = mutableListOf<Map<String, Any>>()
    for (index in 0 until count) {
      val text = textAt(index).trim()
      if (text.isNotEmpty()) {
        total += text.length
        require(total <= 60_000) { "pdf_text_limit_exceeded" }
        pages.add(mapOf("page" to (index + 1), "text" to text))
      }
    }
    return mapOf("pages" to pages, "pageCount" to count)
  }
}
