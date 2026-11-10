package expo.modules.persaitdlib

import android.os.Build
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * A single narrow TDLib JSONJava gateway. No arbitrary JSON requests cross
 * the JS boundary, no contacts/chat listing, no user text in logs or events.
 * JsonClient.java + libtdjsonjava.so are staged ONLY by the reviewed source
 * build; this module compiles and fails closed if they are absent.
 */
class PersaiTelegramTdlibModule : Module() {
  private class NativeJson {
    private val type = Class.forName("org.drinkless.tdlib.JsonClient")
    private val make = type.getMethod("createClientId")
    private val send = type.getMethod("send", Int::class.javaPrimitiveType, String::class.java)
    private val receive = type.getMethod("receive", Double::class.javaPrimitiveType)
    fun create(): Int = make.invoke(null) as Int
    fun send(id: Int, json: String) { send.invoke(null, id, json) }
    fun receive(): String? = receive.invoke(null, 0.25) as? String
  }

  private val lock = Any()
  /** Only TDLib-delivered topic IDs; no caller can enumerate arbitrary chats. */
  private data class ScopedTopic(val id: Long, val kind: String, val pinned: Boolean, val order: Long)
  private val savedTopics = LinkedHashMap<Long, ScopedTopic>()
  private fun safeTopicId(id: Long): Boolean =
    id != Long.MIN_VALUE && id >= -9007199254740991L && id <= 9007199254740991L
  private val sequence = AtomicLong(0)
  private val pending = ConcurrentHashMap<Long, CompletableFuture<JSONObject>>()
  @Volatile private var native: NativeJson? = null
  @Volatile private var clientId = 0
  @Volatile private var activeProfile: String? = null
  @Volatile private var authState = "offline"
  @Volatile private var receiving = false
  @Volatile private var params: JSONObject? = null
  private var worker: Thread? = null

  private fun available(): Boolean = try {
    if (native != null) true else {
      Class.forName("org.drinkless.tdlib.JsonClient")
      System.loadLibrary("tdjsonjava")
      true
    }
  } catch (_: Throwable) { false }

  private fun requireNative(): NativeJson = native ?: throw IllegalStateException("tdlib_binary_unavailable")
  private fun requireState(vararg allowed: String) {
    if (!allowed.contains(authState)) throw IllegalStateException("tdlib_auth_state_mismatch")
  }
  private fun sendNoReply(objectData: JSONObject) {
    requireNative().send(clientId, objectData.toString())
  }
  private fun sendRequest(data: JSONObject, allowNoMoreTopics: Boolean = false): JSONObject {
    val n = requireNative()
    val requestId = sequence.incrementAndGet()
    val future = CompletableFuture<JSONObject>()
    pending[requestId] = future
    data.put("@extra", requestId)
    try {
      n.send(clientId, data.toString())
      val reply = future.get(25, TimeUnit.SECONDS)
      if (reply.optString("@type") == "error") {
        // TDLib uses 404 to mean the Saved Topics list is completely loaded.
        // Permit that only for an explicit loadSavedMessagesTopics request.
        if (allowNoMoreTopics && data.optString("@type") == "loadSavedMessagesTopics" &&
          reply.optInt("code") == 404) return JSONObject().put("@type","ok")
        throw IllegalStateException("tdlib_operation_rejected")
      }
      return reply
    } catch (_: java.util.concurrent.TimeoutException) {
      throw IllegalStateException("tdlib_request_timeout")
    } finally {
      pending.remove(requestId)
    }
  }
  private fun emitAuth(value: String) {
    if (value != authState) {
      authState = value
      sendEvent("onTelegramAuthorizationState", mapOf("state" to value))
    }
  }

  private fun process(packet: String) {
    if (packet.length > 1_000_000) return
    val msg = try { JSONObject(packet) } catch (_: Exception) { return }
    if (msg.optInt("@client_id", -1) != clientId) return

    if (msg.optString("@type") == "updateSavedMessagesTopic") {
      val topic = msg.optJSONObject("topic")
      val id = topic?.optLong("id", Long.MIN_VALUE) ?: Long.MIN_VALUE
      val kind = topic?.optJSONObject("type")?.optString("@type", "") ?: ""
      if (safeTopicId(id) && kind in setOf("savedMessagesTopicTypeMyNotes",
          "savedMessagesTopicTypeAuthorHidden", "savedMessagesTopicTypeChat")) {
        val order = topic?.optLong("order", 0L) ?: 0L
        synchronized(lock) {
          if (order == 0L) savedTopics.remove(id) else {
            savedTopics[id] = ScopedTopic(id,kind,topic?.optBoolean("is_pinned",false) == true,order)
            // Bound in-memory source-ID registry; no parallel DB or index.
            if (savedTopics.size > 256) {
              val least = savedTopics.values.minByOrNull { it.order }
              if (least != null) savedTopics.remove(least.id)
            }
          }
        }
      }
    }
    if (msg.optString("@type") == "updateAuthorizationState") {
      val next = msg.optJSONObject("authorization_state")?.optString("@type") ?: return
      if (next == "authorizationStateWaitTdlibParameters") {
        val input = params ?: return
        // JSON bytes are Base64 strings. No plaintext key/hash is emitted.
        sendNoReply(input)
        params = null
      }
      emitAuth(next)
      if (next == "authorizationStateClosed") receiving = false
    }
    val extra = msg.optLong("@extra", -1)
    if (msg.optString("@type") == "error" && extra < 0) {
      emitAuth("tdlib_runtime_error")
    }
    if (extra > 0) pending[extra]?.complete(msg)
  }

  private fun beginReceive() {
    receiving = true
    worker = Thread({
      while (receiving) {
        try {
          val packet = requireNative().receive()
          if (packet != null) process(packet)
        } catch (_: Throwable) {
          emitAuth("tdlib_runtime_error")
          receiving = false
        }
      }
      pending.values.forEach { it.completeExceptionally(IllegalStateException("tdlib_closed")) }
      pending.clear()
      synchronized(lock) {
        clientId = 0
        activeProfile = null
        native = null
        params = null
        savedTopics.clear()
      }
    }, "PersAI-TDLib-JSON-receiver").also {
      it.isDaemon = true
      it.start()
    }
  }

  private fun initialize(profile: String, apiId: Int, apiHash: String, encryptionKey: String): String {
    require(Regex("^(guest|[a-zA-Z0-9_-]{1,120})$").matches(profile)) { "tdlib_invalid_profile" }
    require(apiId > 0 && Regex("^[a-f0-9]{32}$").matches(apiHash)) { "tdlib_invalid_app_credentials" }
    val key = try { Base64.decode(encryptionKey, Base64.DEFAULT) } catch (_: Exception) { byteArrayOf() }
    require(key.size == 32) { "tdlib_invalid_db_key" }
    require(available()) { "tdlib_binary_unavailable" }
    synchronized(lock) {
      if (clientId != 0) {
        if (activeProfile != profile) throw IllegalStateException("tdlib_other_profile_active")
        if (!receiving) throw IllegalStateException("tdlib_restarting_after_close")
        return authState
      }
      val ctx = appContext.reactContext ?: throw IllegalStateException("tdlib_context_unavailable")
      val root = File(ctx.filesDir, "persai-tdlib-$profile").canonicalFile
      require(root.path.startsWith(ctx.filesDir.canonicalPath + File.separator))
      root.mkdirs()
      val download = File(root,"files").apply { mkdirs() }
      val config = JSONObject().put("@type","setTdlibParameters")
        .put("use_test_dc",false)
        .put("database_directory",root.absolutePath)
        .put("files_directory",download.absolutePath)
        .put("database_encryption_key",Base64.encodeToString(key,Base64.NO_WRAP))
        .put("use_file_database",false)
        .put("use_chat_info_database",false)
        .put("use_message_database",false)
        .put("use_secret_chats",false)
        .put("api_id",apiId)
        .put("api_hash",apiHash)
        .put("system_language_code","ru-RU")
        .put("device_model",Build.MODEL.take(120).ifEmpty { "Android" })
        .put("system_version",Build.VERSION.RELEASE.take(60))
        .put("application_version","PersAI 0.3.0")
      key.fill(0)
      params = config
      val bridge = NativeJson()
      native = bridge
      clientId = bridge.create()
      activeProfile = profile
      authState = "starting"
      savedTopics.clear()
      beginReceive()
      sendNoReply(JSONObject().put("@type","getAuthorizationState"))
      return authState
    }
  }

  private fun auth(type: String, field: String, value: String, allowed: String): String {
    require(value.isNotEmpty() && value.length <= 256) { "tdlib_invalid_auth_input" }
    requireState(allowed)
    sendRequest(JSONObject().put("@type",type).put(field,value))
    return authState
  }


  /** Only read the chat belonging to getMe().id; no arbitrary chat ID in the JS API.
   * The response is an intentionally small projection, never raw TDLib JSON.
   */
  private fun savedPage(profile: String, fromId: String, limit: Int, topicId: Long? = null): String {
    requireState("authorizationStateReady")
    require(Regex("^(guest|[a-zA-Z0-9_-]{1,120})$").matches(profile) &&
      activeProfile == profile) { "tdlib_saved_profile_mismatch" }
    require(limit in 1..20) { "tdlib_saved_page_limit" }
    require(Regex("^(0|[1-9][0-9]{0,15})$").matches(fromId)) { "tdlib_saved_cursor_invalid" }
    val cursor = fromId.toLongOrNull() ?: throw IllegalArgumentException("tdlib_saved_cursor_invalid")
    require(cursor in 0L..9007199254740991L) { "tdlib_saved_cursor_invalid" }
    val self = sendRequest(JSONObject().put("@type", "getMe"))
    require(self.optString("@type") == "user") { "tdlib_self_identity_missing" }
    val selfId = self.optLong("id", 0)
    require(selfId > 0 && selfId <= 9007199254740991L) { "tdlib_self_identity_invalid" }
    val chat = sendRequest(JSONObject().put("@type", "createPrivateChat")
      .put("user_id", selfId).put("force", false))
    require(chat.optString("@type") == "chat") { "tdlib_saved_chat_missing" }
    val chatId = chat.optLong("id", 0)
    // Telegram Saved Messages is the private chat with ourselves, not a channel.
    require(chatId == selfId) { "tdlib_saved_chat_identity_mismatch" }
    if (topicId != null) {
      require(safeTopicId(topicId)) { "tdlib_saved_topic_id_invalid" }
      synchronized(lock) {
        require(savedTopics.containsKey(topicId)) { "tdlib_saved_topic_not_discovered" }
      }
    }
    val query = if (topicId != null)
      JSONObject().put("@type", "getSavedMessagesTopicHistory")
        .put("saved_messages_topic_id", topicId)
        .put("from_message_id", cursor).put("offset", 0).put("limit", limit)
    else
      JSONObject().put("@type", "getChatHistory")
        .put("chat_id", chatId).put("from_message_id", cursor)
        .put("offset", 0).put("limit", limit).put("only_local", false)
    val history = sendRequest(query)
    require(history.optString("@type") == "messages") { "tdlib_saved_history_invalid" }
    val messages = history.optJSONArray("messages")
      ?: throw IllegalStateException("tdlib_saved_messages_missing")
    require(messages.length() <= limit) { "tdlib_saved_page_overflow" }
    val projected = org.json.JSONArray()
    var lastId = 0L
    for (index in 0 until messages.length()) {
      val message = messages.optJSONObject(index)
        ?: throw IllegalStateException("tdlib_saved_message_invalid")
      require(message.optLong("chat_id", 0) == chatId) { "tdlib_saved_source_mismatch" }
      val id = message.optLong("id", 0)
      require(id > 0 && id <= 9007199254740991L &&
        (lastId == 0L || id < lastId) && (cursor == 0L || id <= cursor)) {
        "tdlib_saved_message_order_invalid"
      }
      lastId = id
      val content = message.optJSONObject("content")
      val kind = content?.optString("@type") ?: "unknown"
      val description = if (kind == "messageText") content?.optJSONObject("text")?.optString("text", "")
        else content?.optJSONObject("caption")?.optString("text", "")
      val text = (description ?: "").take(60000)
      projected.put(JSONObject()
        .put("id", id.toString())
        .put("date", message.optLong("date", 0))
        .put("kind", kind.take(80))
        .put("text", text)
        .put("hasMedia", kind != "messageText"))
    }
    // A profile switch/close during the native requests invalidates the result.
    require(activeProfile == profile && authState == "authorizationStateReady") {
      "tdlib_saved_profile_changed"
    }
    // Cursor only indicates next history position; it does NOT ACK imported content.
    return JSONObject().put("messages", projected)
      .put("nextCursor", if (lastId > 0) lastId.toString() else "")
      .put("selfChatId", chatId.toString())
      .apply { if (topicId != null) put("topicId", topicId.toString()) }.toString()
  }


  private fun savedTopicList(profile: String): String {
    requireState("authorizationStateReady")
    require(Regex("^(guest|[a-zA-Z0-9_-]{1,120})$").matches(profile) &&
      activeProfile == profile) { "tdlib_saved_profile_mismatch" }
    // API only supplies topics as updates; loadSavedMessagesTopics returns Ok,
    // not a list. The receiver owns the sole bounded list of verified IDs.
    sendRequest(JSONObject().put("@type","loadSavedMessagesTopics").put("limit",20),
      allowNoMoreTopics = true)
    requireState("authorizationStateReady")
    require(activeProfile == profile) { "tdlib_saved_profile_changed" }
    val projection = org.json.JSONArray()
    synchronized(lock) {
      savedTopics.values.sortedByDescending { it.order }.take(100).forEach { topic ->
        projection.put(JSONObject().put("id",topic.id.toString())
          .put("kind",topic.kind).put("isPinned",topic.pinned)
          .put("order",topic.order.toString()))
      }
    }
    return JSONObject().put("topics",projection).toString()
  }

  override fun definition() = ModuleDefinition {
    Name("PersaiTelegramTdlib")
    Events("onTelegramAuthorizationState")

    // No implicitly downloaded runtime: default builds report false.
    Function("isAvailable") { available() }
    Function("authorizationState") { authState }

    AsyncFunction("initialize") { profile: String, id: Int, hash: String, key: String ->
      initialize(profile,id,hash,key)
    }
    AsyncFunction("submitPhone") { number: String ->
      require(Regex("^\\+[1-9][0-9]{6,14}$").matches(number)) { "tdlib_invalid_phone" }
      requireState("authorizationStateWaitPhoneNumber")
      sendRequest(JSONObject().put("@type","setAuthenticationPhoneNumber")
        .put("phone_number",number).put("settings",JSONObject().put("@type","phoneNumberAuthenticationSettings")))
      authState
    }
    AsyncFunction("submitCode") { code: String ->
      require(Regex("^[0-9]{1,12}$").matches(code)) { "tdlib_invalid_code" }
      auth("checkAuthenticationCode","code",code,"authorizationStateWaitCode")
    }
    AsyncFunction("submitPassword") { password: String ->
      auth("checkAuthenticationPassword","password",password,"authorizationStateWaitPassword")
    }
    AsyncFunction("submitEmail") { email: String ->
      require(email.length in 3..254 && email.contains("@") && !email.contains(" ")) { "tdlib_invalid_email" }
      auth("setAuthenticationEmailAddress","email_address",email,"authorizationStateWaitEmailAddress")
    }
    AsyncFunction("submitEmailCode") { code: String ->
      require(Regex("^[A-Za-z0-9_-]{1,16}$").matches(code)) { "tdlib_invalid_email_code" }
      requireState("authorizationStateWaitEmailCode")
      sendRequest(JSONObject().put("@type","checkAuthenticationEmailCode")
        .put("code",JSONObject().put("@type","emailAddressAuthenticationCode").put("code",code)))
      authState
    }
    // Explicit read-only user action; does not import or delete any Telegram data.
    AsyncFunction("getSavedMessagesPage") { profile: String, fromId: String, limit: Int ->
      savedPage(profile, fromId, limit)
    }
    // Topic IDs are only accepted after an updateSavedMessagesTopic from TDLib.
    AsyncFunction("listSavedMessagesTopics") { profile: String ->
      savedTopicList(profile)
    }
    AsyncFunction("getSavedMessagesTopicPage") {
      profile: String, topicId: String, fromId: String, limit: Int ->
      require(Regex("^(0|-?[1-9][0-9]{0,15})$").matches(topicId)) {
        "tdlib_saved_topic_id_invalid"
      }
      val requested = topicId.toLongOrNull()
        ?: throw IllegalArgumentException("tdlib_saved_topic_id_invalid")
      savedPage(profile,fromId,limit,requested)
    }
    AsyncFunction("logOut") {
      requireState("authorizationStateReady")
      sendRequest(JSONObject().put("@type","logOut"))
      authState
    }
    AsyncFunction("close") {
      if (clientId == 0) "offline" else {
        sendRequest(JSONObject().put("@type","close"))
        authState
      }
    }
  }
}
