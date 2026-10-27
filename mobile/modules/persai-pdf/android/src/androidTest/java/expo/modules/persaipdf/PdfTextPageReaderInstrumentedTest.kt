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
    PdfDocument().use { pdf ->
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
    }
    return file
  }

  @Test fun readsTwoRealPdfTextPagesWithOriginalPageNumbers() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf("PERSAI_FIRST_PAGE_123", null, "PERSAI_THIRD_PAGE_987")
    try {
      val pages = PdfTextPageReader.read(file, 128)
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

  @Test fun scannedOrBlankPdfHasNoTextLayerAndNoPageEvidence() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val file = pdf(null)
    try {
      assertTrue(PdfTextPageReader.read(file, 128).isEmpty())
    } finally { file.delete() }
  }
}
