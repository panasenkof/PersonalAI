package expo.modules.persaipdf

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

/**
 * Restricted local-only entrypoint: the extraction core accepts seekable PDFs
 * only inside this app's files/cache sandbox, never arbitrary external URIs.
 */
class PersaiPdfTextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PersaiPdfText")

    Function("isAvailable") { PdfTextPageReader.isSupported() }

    AsyncFunction("extractPages") { uri: String, pageLimit: Int ->
      require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
      require(uri.startsWith("file://")) { "pdf_requires_local_file" }

      val file = File(URI(uri)).canonicalFile
      val context = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile,
        context.getExternalFilesDir(null)?.canonicalFile).filterNotNull()
      require(roots.any { file.path.startsWith(it.path + File.separator) }) {
        "pdf_outside_app_storage"
      }

      return@AsyncFunction PdfTextPageReader.read(file, pageLimit)
    }
  }
}
