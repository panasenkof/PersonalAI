package expo.modules.persaipdf

import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real PDF bytes, generated and parsed by the device's own PDF engine.
 * Covers exact page identity, gaps and the distinction from scanned pages.
 * No network, user file, image OCR or mocked page response is involved.
 */
@RunWith(AndroidJUnit4::class)
class PdfTextPageReaderInstrumentedTest {
  private fun pdf(vararg pageTexts: String?): File {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File.createTempFile("persai-pdf-", ".pdf", context.cacheDir)
    val pdf = PdfDocument()
    try {
      pageTexts.forEachIndexed { index, text ->
        val page = pdf.startPage(
          PdfDocument.PageInfo.Builder(595, 842, index + 1).create()
        )
        if (text != null) {
          val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f }
          page.canvas.drawText(text, 36f, 80f, paint)
        }
        pdf.finishPage(page)
      }
      file.outputStream().use { pdf.writeTo(it) }
    } finally {
      pdf.close()
    }
    return file
  }

  @Test fun russianOcrNeverProcessesPersonalOriginalWithoutVerifiedModel() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "ocr-empty-model-directory")
    root.mkdirs()
    val original = pdf("ТЕКСТ", null)
    try {
      assertFalse(LocalRussianOcr.installed(root))
      try {
        LocalRussianOcr.document(root, original, 1)
        fail("OCR must reject missing/untrusted model before reading the PDF")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("russian_ocr_model_missing_or_invalid"))
      }
    } finally {
      original.delete()
      root.deleteRecursively()
    }
  }

  @Test fun readsTwoRealPdfTextPagesWithOriginalPageNumbers() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf("PERSAI_FIRST_PAGE_123", null, "PERSAI_THIRD_PAGE_987")
    try {
      val result = PdfTextPageReader.read(file, 128)
      assertEquals(3, result["pageCount"])
      @Suppress("UNCHECKED_CAST")
      val pages = result["pages"] as List<Map<String, Any>>
      assertEquals(listOf(1, 3), pages.map { it["page"] as Int })
      assertTrue((pages[0]["text"] as String).contains("PERSAI_FIRST_PAGE_123"))
      assertTrue((pages[1]["text"] as String).contains("PERSAI_THIRD_PAGE_987"))
      assertFalse(pages.any { it["page"] == 2 })
    } finally { file.delete() }
  }

  @Test fun rejectsPdfOverPageCountWithoutFabricatedPartialCoverage() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf("PAGE_ONE", "PAGE_TWO")
    try {
      try {
        PdfTextPageReader.read(file, 1)
        fail("PDF page limit must reject the entire extraction")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("pdf_page_limit_exceeded"))
      }
    } finally { file.delete() }
  }

  @Test fun boundedPdfPageWindowKeepsRealScanGapsAndPageIndices() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf("FIRST_TEXT", null, "THIRD_TEXT", "FOURTH_TEXT")
    try {
      val second = PdfTextPageReader.readRange(file, 2, 2)
      assertEquals(4, second["pageCount"])
      assertEquals(2, second["firstPage"])
      assertEquals(2, second["processedPageCount"])
      @Suppress("UNCHECKED_CAST")
      val pages = second["pages"] as List<Map<String, Any>>
      assertEquals(listOf(3), pages.map { it["page"] as Int })
      assertTrue((pages[0]["text"] as String).contains("THIRD_TEXT"))
      val last = PdfTextPageReader.readRange(file, 4, 16)
      assertEquals(1, last["processedPageCount"])
      try {
        PdfTextPageReader.readRange(file, 5, 1)
        fail("Range past the real PDF length must not fabricate pages")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("invalid_pdf_page_window"))
      }
    } finally { file.delete() }
  }

  @Test fun largePdfReadRangeCanContinuePastLegacy128PageLimit() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val texts=Array<String?>(130) { i -> when(i) {
      0 -> "START_PAGE"; 128 -> "TEXT_ON_PAGE_129"; 129 -> "LAST_PAGE_130"; else -> null
    } }
    val file=pdf(*texts)
    try {
      val last=PdfTextPageReader.readRange(file, 129, 16)
      assertEquals(130,last["pageCount"])
      assertEquals(2,last["processedPageCount"])
      @Suppress("UNCHECKED_CAST")
      val pages=last["pages"] as List<Map<String, Any>>
      assertEquals(listOf(129,130),pages.map { it["page"] as Int })
      try {
        PdfTextPageReader.read(file, 128)
        fail("Legacy extraction must preserve its previous explicit guard")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("pdf_page_limit_exceeded"))
      }
    } finally { file.delete() }
  }

  @Test fun rendersRealPagesIncludingBlankScanWithoutRecognizingText() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val source = pdf("VISIBLE_FIRST", null, "VISIBLE_LAST")
    val previews = mutableListOf<File>()
    try {
      for (number in listOf(1, 2, 3)) {
        val result = PdfPageRasterizer.render(source, context.cacheDir, number, 900)
        assertEquals(number, result["page"])
        assertEquals(3, result["pageCount"])
        val output = File(android.net.Uri.parse(result["uri"] as String).path!!)
        previews.add(output)
        assertTrue(output.isFile)
        assertTrue(output.length() > 100)
        output.inputStream().use { stream ->
          assertEquals(0xff, stream.read())
          assertEquals(0xd8, stream.read())
        }
        val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(output.path, options)
        assertTrue(options.outWidth in 1..1600)
        assertTrue(options.outHeight in 1..1800)
        assertTrue(options.outWidth.toLong()*options.outHeight <= 3_000_000)
      }
      try {
        PdfPageRasterizer.render(source, context.cacheDir, 4, 900)
        fail("Out-of-range page must never return a fabricated preview")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("invalid_pdf_preview_page"))
      }
      try {
        PdfPageRasterizer.render(source, context.cacheDir, 1, 5000)
        fail("Unsafe raster dimensions must fail closed")
      } catch (e: IllegalArgumentException) {
        assertTrue(e.message.orEmpty().contains("invalid_pdf_preview_size"))
      }
    } finally {
      previews.forEach { it.delete() }
      source.delete()
    }
  }

  @Test fun scannedOrBlankPdfHasNoTextLayerAndNoPageEvidence() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf(null)
    try {
      val result = PdfTextPageReader.read(file, 128)
      assertEquals(1, result["pageCount"])
      assertEquals(emptyList<Any>(), result["pages"])
    } finally { file.delete() }
  }
}
