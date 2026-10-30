package com.persai.visionlab

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Debug
import android.os.SystemClock
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.persai.visionsdkprobe.UniversalVisionCompileProbe
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Separate, offline, installable №83.1 experiment for Android 16 / ARM64.
 * No PersAI profile, internet permission, background service or image storage.
 * The user deliberately selects a local .litertlm model and ONE image via SAF.
 */
class MainActivity : Activity() {
  private companion object {
    const val MODEL_PICK = 71
    const val IMAGE_PICK = 72
    const val MAX_MODEL_BYTES = 900L * 1024 * 1024
    const val MAX_IMAGE_SIDE = 16384
  }
  private val worker = Executors.newSingleThreadExecutor()
  private lateinit var status: TextView
  private lateinit var query: EditText
  private lateinit var runButton: Button
  private var imageUri: Uri? = null
  private var importedModel: File? = null
  private var modelDigest: String? = null
  private var busy = false

  private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val page = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(18), dp(18), dp(28))
    }
    val header = TextView(this).apply {
      text = "PersAI Vision Lab · №83.1"
      textSize = 23f
    }
    page.addView(header)
    val info = TextView(this).apply {
      text = "Эксперимент для Android 16. Всё происходит на телефоне. " +
        "Это отдельное приложение: оно не открывает память PersAI и не отправляет фото в интернет. " +
        "Выберите официальный файл модели EmbeddingGemma 2 Text-Vision (.litertlm), " +
        "затем фотографию и введите запрос на русском."
      textSize = 15f
      setPadding(0, dp(10), 0, dp(18))
    }
    page.addView(info)

    val pickModel = Button(this).apply {
      text = "1. Выбрать модель (.litertlm)"
      setOnClickListener { if (!busy) chooseFile("*/*", MODEL_PICK) }
    }
    page.addView(pickModel, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    val pickImage = Button(this).apply {
      text = "2. Выбрать фотографию"
      setOnClickListener { if (!busy) chooseFile("image/*", IMAGE_PICK) }
    }
    page.addView(pickImage, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    query = EditText(this).apply {
      hint = "Что изображено на фото?"
      setSingleLine(true)
      setText("красный велосипед возле дерева")
      textSize = 17f
    }
    page.addView(query, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    runButton = Button(this).apply {
      text = "3. Проверить сходство локально"
      setOnClickListener { compare() }
    }
    page.addView(runButton, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    status = TextView(this).apply {
      text = "Модель и фото не выбраны. Сначала скачайте модель из официального каталога LiteRT Community."
      textSize = 15f
      setPadding(0, dp(18), 0, 0)
    }
    page.addView(status)

    val scroll = ScrollView(this)
    scroll.addView(page)
    setContentView(scroll)
  }

  private fun chooseFile(mime: String, code: Int) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mime
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    startActivityForResult(intent, code)
  }

  @Deprecated("Android activity result API is sufficient for this independent lab")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode != RESULT_OK) return
    val uri = data?.data ?: return
    if (requestCode == IMAGE_PICK) {
      imageUri = uri
      status.text = "Фотография выбрана. Изображение не сохраняется в памяти приложения."
    } else if (requestCode == MODEL_PICK) {
      importModel(uri)
    }
  }

  private fun startTask(label: String, task: () -> Unit) {
    if (busy) return
    busy = true
    runButton.isEnabled = false
    status.text = label
    worker.execute {
      try {
        task()
      } catch (error: Throwable) {
        // Never log or show the selected URI, model bytes, query or photo.
        update("Ошибка проверки: ${error.javaClass.simpleName}. " +
          "Попробуйте оригинальный файл модели и другое изображение.")
      } finally {
        if (!isDestroyed) runOnUiThread {
          busy = false
          runButton.isEnabled = true
        }
      }
    }
  }

  private fun update(text: String) {
    if (!isDestroyed) runOnUiThread { status.text = text }
  }

  private fun importModel(uri: Uri) {
    startTask("Импорт модели во внутреннее хранилище (без сети)…") {
      val folder = File(filesDir, "vision-lab").apply { mkdirs() }
      val temp = File(folder, "model.partial")
      val target = File(folder, "embeddinggemma-2-text-vision-440m.litertlm")
      val digest = MessageDigest.getInstance("SHA-256")
      try {
        var count = 0L
        val stream = contentResolver.openInputStream(uri)
          ?: error("model_stream_unavailable")
        stream.use { input ->
          temp.outputStream().buffered().use { output ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              count += n
              check(count <= MAX_MODEL_BYTES) { "model_too_large" }
              output.write(buffer, 0, n)
              digest.update(buffer, 0, n)
            }
            output.flush()
          }
        }
        check(count >= 1024 * 1024) { "invalid_model_size" }
        check(temp.renameTo(target)) { "model_atomic_install_failed" }
        val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        importedModel = target
        modelDigest = hash
        update("Модель локально импортирована: ${count / (1024 * 1024)} МиБ. " +
          "SHA-256: ${hash.take(16)}… Выберите фото и запустите сравнение.")
      } finally {
        if (temp.exists()) temp.delete()
      }
    }
  }

  private fun decodeBoundedImage(uri: Uri): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val boundsStream = contentResolver.openInputStream(uri)
      ?: error("image_not_accessible")
    boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
    // With inJustDecodeBounds=true, decodeStream intentionally returns null;
    // only the dimensions in bounds are meaningful.
    check(bounds.outWidth in 1..MAX_IMAGE_SIDE &&
      bounds.outHeight in 1..MAX_IMAGE_SIDE) { "image_dimensions_invalid" }
    // BitmapFactory.Options.inSampleSize defaults to zero on Android.
    // The platform decoder treats zero as 1, but our own division must not.
    val sampled = BitmapFactory.Options().apply {
      inSampleSize = ImageSampling.factor(bounds.outWidth, bounds.outHeight)
    }
    return contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, sampled)
    } ?: error("image_decode_failed")
  }

  private fun compare() {
    val model = importedModel
    val image = imageUri
    val textQuery = query.text.toString().trim()
    if (model == null || image == null || textQuery.isBlank() || textQuery.length > 256) {
      status.text = "Сначала выберите модель, фотографию и короткий запрос."
      return
    }
    startTask("Модель анализирует изображение только на устройстве…") {
      val bitmap = decodeBoundedImage(image)
      try {
        val before = Debug.MemoryInfo().apply { Debug.getMemoryInfo(this) }.totalPss
        val start = SystemClock.elapsedRealtime()
        val similarity = UniversalVisionCompileProbe.compare(this, model, bitmap, textQuery)
        val elapsed = SystemClock.elapsedRealtime() - start
        val after = Debug.MemoryInfo().apply { Debug.getMemoryInfo(this) }.totalPss
        update("Готово. Косинусное сходство: ${"%.4f".format(similarity)}. " +
          "Время холодного вызова: ${elapsed} мс. " +
          "PSS процесса до/после: ${before / 1024}/${after / 1024} МиБ. " +
          "Отпечаток модели: ${modelDigest?.take(16)}…. " +
          "Это сходство, НЕ доказательство идентичности объекта. " +
          "Пиковая RAM/нагрев отдельно не измерены.")
      } finally {
        bitmap.recycle()
      }
    }
  }

  override fun onDestroy() {
    worker.shutdown()
    super.onDestroy()
  }
}
