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
  private fun appLocalPdf(uri: String): File {
    require(uri.startsWith("file://")) { "pdf_requires_local_file" }
    val context = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
    val file = File(URI(uri)).canonicalFile
    val roots = listOf(context.filesDir.canonicalFile, context.cacheDir.canonicalFile,
      context.getExternalFilesDir(null)?.canonicalFile).filterNotNull()
    require(roots.any { file.path.startsWith(it.path + File.separator) }) {
      "pdf_outside_app_storage"
    }
    return file
  }

  override fun definition() = ModuleDefinition {
    Name("PersaiPdfText")

    Function("isAvailable") { PdfTextPageReader.isSupported() }

    Function("isRussianOcrInstalled") {
      val ctx = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      LocalRussianOcr.installed(ctx.filesDir)
    }

    AsyncFunction("recognizeRussianImage") { uri: String ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      return@AsyncFunction LocalRussianOcr.photo(ctx.filesDir, appLocalPdf(uri))
    }

    AsyncFunction("recognizeRussianPdf") { uri: String, fromPage: Int ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      return@AsyncFunction LocalRussianOcr.document(ctx.filesDir, appLocalPdf(uri), fromPage)
    }

    Function("isPagePreviewAvailable") { PdfPageRasterizer.isSupported() }

    AsyncFunction("extractPages") { uri: String, pageLimit: Int ->
      require(pageLimit in 1..128) { "invalid_pdf_page_limit" }
      return@AsyncFunction PdfTextPageReader.read(appLocalPdf(uri), pageLimit)
    }

    AsyncFunction("extractPageRange") { uri: String, firstPage: Int, count: Int ->
      require(firstPage >= 1 && count in 1..16) { "invalid_pdf_page_window" }
      return@AsyncFunction PdfTextPageReader.readRange(appLocalPdf(uri), firstPage, count)
    }

    AsyncFunction("renderPage") { uri: String, pageNumber: Int, maxWidth: Int ->
      val context = appContext.reactContext ?: throw IllegalStateException("pdf_context_unavailable")
      return@AsyncFunction PdfPageRasterizer.render(
        appLocalPdf(uri), context.cacheDir, pageNumber, maxWidth)
    }
  }
}
