package expo.modules.persaipdf

import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

/**
 * Small, offline-only PDF text-layer reader for Android 15+.
 * Unlike rendering/OCR, getTextContents gives the *real* one-based PDF page.
 * Old Android versions cannot expose this API; fail closed, never fake pages.
 */
class PersaiPdfTextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PersaiPdfText")

    AsyncFunction("extractPages") { uri: String, pageLimit: Int ->
      require(Build.VERSION.SDK_INT >= 35) { "pdf_text_requires_android_15" }
      require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
      require(uri.startsWith("file://")) { "pdf_requires_local_file" }

      val file = File(URI(uri)).canonicalFile
      val context = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile,
        context.getExternalFilesDir(null)?.canonicalFile).filterNotNull()
      require(roots.any { file.path.startsWith(it.path + File.separator) }) { "pdf_outside_app_storage" }
      require(file.isFile && file.length() in 1..(80L * 1024L * 1024L)) { "pdf_file_unavailable_or_too_large" }

      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { document ->
          require(document.pageCount in 1..pageLimit) { "pdf_page_limit_exceeded" }
          var total = 0
          val pages = mutableListOf<Map<String, Any>>()
          for (index in 0 until document.pageCount) {
            document.openPage(index).use { page ->
              val text = page.textContents.joinToString("\n") { it.text }.trim()
              if (text.isNotEmpty()) {
                total += text.length
                require(total <= 60000) { "pdf_text_limit_exceeded" }
                pages.add(mapOf("page" to (index + 1), "text" to text))
              }
            }
          }
          return@AsyncFunction pages
        }
      }
    }
  }
}
