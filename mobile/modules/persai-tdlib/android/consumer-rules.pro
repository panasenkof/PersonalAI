# The gateway uses Class.forName and Java reflection; removing/renaming this
# JNI class would turn a successfully staged native TDLib binary into an
# unavailable Telegram client in a release APK.
-keep class org.drinkless.tdlib.JsonClient { *; }
