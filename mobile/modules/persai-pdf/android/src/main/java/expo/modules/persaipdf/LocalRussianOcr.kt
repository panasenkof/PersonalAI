package expo.modules.persaipdf

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Real on-device Cyrillic OCR with Tesseract5 / rus tessdata_fast.
 * No SDK calls/network permission. The trained model is NOT packaged; the
 * owner installs it explicitly from a pinned, SHA-256-verified download.
 *
 * Strictly serial single-file processing. Text-layer PDF pages are never
 * OCR'd a second time; the original source page numbers are authoritative.
 */
internal object LocalRussianOcr {
  const val MODEL_SHA = "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225"
  const val MODEL_BYTES = 3_861_738L
  private const val MAX_PDF_PAGES = 128
  private const val MAX_CHARS = 60_000
  private const val OCR_PAGES_PER_ACTION = 8
  private val serial = Any()

  private fun modelFile(root: File) = File(root, "tessdata/rus.traineddata")

  private fun validModel(root: File): Boolean {
    val file = modelFile(root)
    if (!file.isFile || file.length() != MODEL_BYTES) return false
    val md = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) } == MODEL_SHA
  }

  fun installed(root: File): Boolean = validModel(root)

  private fun <T> withEngine(root: File, work: (TessBaseAPI) -> T): T =
    synchronized(serial) {
      require(validModel(root)) { "russian_ocr_model_missing_or_invalid" }
      val tess = TessBaseAPI()
      try {
        require(tess.init(root.absolutePath, "rus", TessBaseAPI.OEM_LSTM_ONLY)) {
          "russian_ocr_engine_initialization_failed"
        }
        work(tess)
      } finally { tess.recycle() }
    }

  private fun boundedImage(file: File): Bitmap {
    require(file.isFile && file.length() in 1..(8L * 1024 * 1024)) { "russian_ocr_image_limit" }
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, opts)
    require(opts.outWidth in 1..12_000 && opts.outHeight in 1..12_000) { "russian_ocr_invalid_image" }
    var sample = 1
    while (opts.outWidth / sample > 1800 || opts.outHeight / sample > 1800 ||
      opts.outWidth.toLong() * opts.outHeight > 3_000_000L * sample * sample) sample *= 2
    val decode = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeFile(file.absolutePath, decode) ?: error("russian_ocr_decode_failed")
  }

  fun photo(root: File, image: File): String = withEngine(root) { tess ->
    boundedImage(image).let { bitmap ->
      try {
        tess.setImage(bitmap)
        val text = tess.getUTF8Text()?.trim().orEmpty()
        require(text.length <= MAX_CHARS) { "russian_ocr_text_limit" }
        text
      } finally { bitmap.recycle() }
    }
  }

  private fun renderPage(page: PdfRenderer.Page): Bitmap {
    val width = page.width.coerceAtLeast(1)
    val height = page.height.coerceAtLeast(1)
    val factor = min(
      min(1600.0 / width, 1800.0 / height),
      sqrt(3_000_000.0 / (width.toDouble() * height))
    ).coerceAtMost(1.8)
    val bitmap = Bitmap.createBitmap((width * factor).roundToInt().coerceIn(1, 1600),
      (height * factor).roundToInt().coerceIn(1, 1800), Bitmap.Config.ARGB_8888)
    try {
      bitmap.eraseColor(android.graphics.Color.WHITE)
      page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
    } catch (error: Throwable) {
      bitmap.recycle()
      throw error
    }
    return bitmap
  }

  fun document(root: File, pdfFile: File, fromPage: Int = 1): Map<String, Any> = withEngine(root) { tess ->
    require(Build.VERSION.SDK_INT >= 35) { "russian_ocr_pdf_requires_android_15" }
    require(pdfFile.isFile && pdfFile.length() in 1..(80L * 1024 * 1024)) { "russian_ocr_pdf_limit" }
    require(fromPage in 1..MAX_PDF_PAGES) { "russian_ocr_invalid_first_page" }
    ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
      PdfRenderer(fd).use { pdf ->
        val pageCount = pdf.pageCount
        require(pageCount in 1..MAX_PDF_PAGES) { "pdf_page_limit_exceeded" }
        require(fromPage <= pageCount) { "russian_ocr_invalid_first_page" }
        val output = mutableListOf<Map<String, Any>>()
        var total = 0
        var ocrDone = 0
        for (index in 0 until pageCount) {
          pdf.openPage(index).use { page ->
            // A later chunk may omit all earlier scanned pages, but still
            // includes their known native text-layer; never fabricate OCR.
            val layer = page.textContents.joinToString("\n") { it.text }.trim()
            if (layer.isNotEmpty()) {
              total += layer.length
              require(total <= MAX_CHARS) { "russian_ocr_text_limit" }
              output.add(mapOf("page" to index + 1, "text" to layer, "source" to "text"))
            } else if (index + 1 >= fromPage && ocrDone < OCR_PAGES_PER_ACTION) {
              ocrDone++
              val bitmap = renderPage(page)
              try {
                tess.setImage(bitmap)
                val read = tess.getUTF8Text()?.trim().orEmpty()
                if (read.isNotEmpty()) {
                  total += read.length
                  require(total <= MAX_CHARS) { "russian_ocr_text_limit" }
                  output.add(mapOf("page" to index + 1, "text" to read, "source" to "ocr"))
                }
              } finally { bitmap.recycle() }
            }
          }
        }
        mapOf("pageCount" to pageCount, "pages" to output,
          "ocrPagesAttempted" to ocrDone, "nextPage" to min(pageCount + 1, fromPage + ocrDone))
      }
    }
  }
}
