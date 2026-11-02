package expo.modules.persaipdf

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * REAL OCR: test-only, SHA-256-pinned Russian model comes from CI's verified
 * androidTest assets, never the user-facing APK. No mock OCR response.
 */
@RunWith(AndroidJUnit4::class)
class LocalRussianOcrInstrumentedTest {
  private fun verifiedRoot(): File {
    val instrument = InstrumentationRegistry.getInstrumentation()
    val root = instrument.targetContext.filesDir
    val file = File(root, "tessdata/rus.traineddata")
    file.parentFile!!.mkdirs()
    instrument.context.assets.open("rus.traineddata").use { asset ->
      file.outputStream().use { output -> asset.copyTo(output) }
    }
    assertTrue("Russian OCR model fixture SHA must match official pinned bytes", LocalRussianOcr.installed(root))
    return root
  }

  private fun photo(): Bitmap {
    val bitmap = Bitmap.createBitmap(1200, 450, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.WHITE)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      textSize = 78f
    }
    canvas.drawText("РЕЦЕПТ", 65f, 165f, paint)
    canvas.drawText("250 ГРАММ", 65f, 320f, paint)
    return bitmap
  }

  @Test fun realCyrillicAndDigitsFromImageStayOnDevice() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val root = verifiedRoot()
    val bitmap = photo()
    val source = File.createTempFile("rus-golden-", ".png",
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
    try {
      source.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
      val text = LocalRussianOcr.photo(root, source)
      assertTrue("Native OCR must recognize the literal numeric quantity; not a mock", text.contains("250"))
      assertTrue("Native OCR must emit Cyrillic, not only numeric guesses", text.any { it in 'А'..'я' || it == 'Ё' || it == 'ё' })
    } finally {
      bitmap.recycle()
      source.delete()
    }
  }

  @Test fun realScanPdfHasOriginalPageAndNeverOcrsExistingDigitalLayer() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    val root = verifiedRoot()
    val scan = photo()
    val source = File.createTempFile("rus-scanned-", ".pdf",
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
    val doc = PdfDocument()
    try {
      val first = doc.startPage(PdfDocument.PageInfo.Builder(1250, 500, 1).create())
      first.canvas.drawText("DIGITAL LAYER 111", 60f, 150f, Paint().apply {
        color=Color.BLACK; textSize=72f
      })
      doc.finishPage(first)
      val second = doc.startPage(PdfDocument.PageInfo.Builder(1250, 500, 2).create())
      second.canvas.drawBitmap(scan, 0f, 0f, null)
      doc.finishPage(second)
      source.outputStream().use { doc.writeTo(it) }
    } finally {
      scan.recycle()
      doc.close()
    }
    try {
      val result = LocalRussianOcr.document(root, source, 1)
      assertEquals(2, result["pageCount"])
      @Suppress("UNCHECKED_CAST")
      val pages = result["pages"] as List<Map<String, Any>>
      assertEquals(listOf(1,2), pages.map { it["page"] })
      assertEquals(listOf("text","ocr"), pages.map { it["source"] })
      assertTrue((pages[0]["text"] as String).contains("DIGITAL LAYER 111"))
      assertTrue((pages[1]["text"] as String).contains("250"))
      assertEquals(1, result["ocrPagesAttempted"])
    } finally { source.delete() }
  }
}
