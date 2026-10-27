package expo.modules.persaipdf

import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.ext.SdkExtensions
import java.io.File

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

  fun read(file: File, pageLimit: Int): List<Map<String, Any>> {
    require(isSupported()) { "pdf_text_layer_unavailable_on_device" }
    require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
    require(file.isFile && file.length() in 1..(80L * 1024L * 1024L)) {
      "pdf_file_unavailable_or_too_large"
    }

    // Read from a seekable file descriptor. Both platform renderers release
    // pages and descriptors even when a PDF is malformed or over the limit.
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
  }

  private fun collect(
    count: Int,
    pageLimit: Int,
    textAt: (index: Int) -> String,
  ): List<Map<String, Any>> {
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
    return pages
  }
}
