package expo.modules.persaipdf

import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.os.ext.SdkExtensions
import android.os.Build
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

/**
 * Offline-only PDF text-layer reader for Android 15+, plus Android 12–14\n * devices that have S Extensions 13. No bundled PDF native library.
 * Unlike rendering/OCR, getTextContents gives the *real* one-based PDF page.
 * Old Android versions cannot expose this API; fail closed, never fake pages.
 */
class PersaiPdfTextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PersaiPdfText")
    Function("isSupported") {
      Build.VERSION.SDK_INT >= 35 ||
        (Build.VERSION.SDK_INT >= 31 &&
          SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= 13)
    }

    AsyncFunction("extractPages") { uri: String, pageLimit: Int ->
      val api35 = Build.VERSION.SDK_INT >= 35
      val preV = Build.VERSION.SDK_INT >= 31 && !api35 &&
        SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= 13
      require(api35 || preV) { "pdf_text_requires_android_15_or_s_extension_13" }
      require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
      require(uri.startsWith("file://")) { "pdf_requires_local_file" }

      val file = File(URI(uri)).canonicalFile
      val context = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile,
        context.getExternalFilesDir(null)?.canonicalFile).filterNotNull()
      require(roots.any { file.path.startsWith(it.path + File.separator) }) { "pdf_outside_app_storage" }
      require(file.isFile && file.length() in 1..(80L * 1024L * 1024L)) { "pdf_file_unavailable_or_too_large" }

      // PdfRendererPreV owns its PFD and closes it with its renderer.
      // Keep old/new API calls in separate branches: never touch PreV on
      // devices whose runtime does not expose its S extension methods.
      val pages = if (api35) readApi35(file, pageLimit) else readExtension13(file, pageLimit)
      return@AsyncFunction pages
    }
  }
  private fun readApi35(file: File, limit: Int): List<Map<String, Any>> {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      PdfRenderer(fd).use { pdf ->
        require(pdf.pageCount in 1..limit) { "pdf_page_limit_exceeded" }
        var total = 0
        val result = mutableListOf<Map<String, Any>>()
        for (i in 0 until pdf.pageCount) {
          pdf.openPage(i).use { page ->
            val text = page.textContents.joinToString("\\n") { it.text }.trim()
            if (text.isNotEmpty()) {
              total += text.length
              require(total <= 60000) { "pdf_text_limit_exceeded" }
              result.add(mapOf("page" to i + 1, "text" to text))
            }
          }
        }
        return result
      }
    }
  }

  private fun readExtension13(file: File, limit: Int): List<Map<String, Any>> {
    // Android 12+ S Extensions 13 exposes PdfRendererPreV without bundling
    // an additional PDF engine. May be absent on otherwise eligible phones.
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      PdfRendererPreV(fd).use { pdf ->
        require(pdf.pageCount in 1..limit) { "pdf_page_limit_exceeded" }
        var total = 0
        val result = mutableListOf<Map<String, Any>>()
        for (i in 0 until pdf.pageCount) {
          pdf.openPage(i).use { page ->
            val text = page.textContents.joinToString("\\n") { it.text }.trim()
            if (text.isNotEmpty()) {
              total += text.length
              require(total <= 60000) { "pdf_text_limit_exceeded" }
              result.add(mapOf("page" to i + 1, "text" to text))
            }
          }
        }
        return result
      }
    }
  }
}
