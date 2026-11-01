package expo.modules.persaipdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * A single source PDF page rendered entirely on-device. This is NOT OCR:
 * the JPEG remains an unindexed, short-lived preview and has no source text.
 * Android 15+ only (older PDF text-layer extension support stays unchanged).
 */
internal object PdfPageRasterizer {
  fun isSupported(): Boolean = Build.VERSION.SDK_INT >= 35

  fun render(source: File, cacheDir: File, pageNumber: Int, maxWidth: Int): Map<String, Any> {
    require(isSupported()) { "pdf_page_renderer_unavailable" }
    require(source.isFile && source.length() in 1..(80L * 1024L * 1024L)) {
      "pdf_file_unavailable_or_too_large"
    }
    require(pageNumber in 1..128) { "invalid_pdf_preview_page" }
    require(maxWidth in 240..1600) { "invalid_pdf_preview_size" }

    var output: File? = null
    try {
      ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { pdf ->
          require(pdf.pageCount in 1..128) { "pdf_page_limit_exceeded" }
          require(pageNumber <= pdf.pageCount) { "invalid_pdf_preview_page" }
          pdf.openPage(pageNumber - 1).use { page ->
            val originalWidth = page.width.coerceAtLeast(1)
            val originalHeight = page.height.coerceAtLeast(1)
            val maxPixels = 3_000_000.0
            val factor = min(
              min(maxWidth.toDouble() / originalWidth, 1800.0 / originalHeight),
              sqrt(maxPixels / (originalWidth.toDouble() * originalHeight))
            ).coerceAtMost(1.8)
            val width = (originalWidth * factor).roundToInt().coerceIn(1, 1600)
            val height = (originalHeight * factor).roundToInt().coerceIn(1, 1800)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
              bitmap.eraseColor(Color.WHITE)
              page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              val directory = File(cacheDir, "persai-pdf-page-previews").canonicalFile
              require(directory.isDirectory || directory.mkdirs()) { "pdf_preview_cache_unavailable" }
              output = File.createTempFile("page-", ".jpg", directory)
              FileOutputStream(output!!).use { stream ->
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, 86, stream)) {
                  "pdf_preview_encode_failed"
                }
              }
            } finally {
              bitmap.recycle()
            }
          }
          return mapOf(
            "uri" to Uri.fromFile(output!!).toString(),
            "page" to pageNumber,
            "pageCount" to pdf.pageCount
          )
        }
      }
    } catch (error: Exception) {
      output?.delete()
      throw error
    }
  }
}
