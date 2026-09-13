plugins {
  id("com.android.application")
}

/*
 * Every value a game supplies comes in as a Gradle property, passed by the packager from
 * `drift.package.json`. Defaults are here so the template builds on its own — which is what makes
 * it possible to check that it compiles without a consumer — and are visibly placeholders.
 */
val driftAppId: String = (project.findProperty("driftAppId") as String?) ?: "dev.driftengine.host"
val driftAppName: String = (project.findProperty("driftAppName") as String?) ?: "DriftEngine Host"
val driftVersionName: String = (project.findProperty("driftVersionName") as String?) ?: "0.0.0"
val driftVersionCode: Int = ((project.findProperty("driftVersionCode") as String?) ?: "1").toInt()

/*
 * Signing comes in as properties too, and never from a file in this template. Android will not
 * install an unsigned APK at all, so there is no unsigned option to offer: the packager either
 * passes a keystore somebody owns or one it generated, and it says which on every build.
 */
val driftKeystore: String? = project.findProperty("driftKeystore") as String?

android {
  namespace = "dev.driftengine.host"
  compileSdk = 35

  defaultConfig {
    applicationId = driftAppId
    /*
     * 26 is Android 8.0. Below it the WebView is old enough that WebGL2 is not a safe assumption,
     * and `addDocumentStartJavaScript` — which is how the bridge reaches the page before the
     * game's own scripts — needs a WebView from 2020 anyway.
     */
    minSdk = 26
    targetSdk = 35
    versionCode = driftVersionCode
    versionName = driftVersionName
    resValue("string", "app_name", driftAppName)
  }

  signingConfigs {
    if (driftKeystore != null) {
      create("drift") {
        storeFile = file(driftKeystore)
        storePassword = (project.findProperty("driftKeystorePassword") as String?) ?: ""
        keyAlias = (project.findProperty("driftKeyAlias") as String?) ?: "drift"
        keyPassword = (project.findProperty("driftKeyPassword") as String?) ?: ""
      }
    }
  }

  buildTypes {
    /*
     * **Debuggable is off in both.** A release built here is the one a person installs, and a
     * debuggable build lets anything on the device attach to the WebView and read the game's
     * storage. `drift-package` builds the debug variant only so that the signing key can be the
     * throwaway one below; it is not a development build in any other sense.
     */
    getByName("debug") {
      isDebuggable = false
      isMinifyEnabled = false
    }
    getByName("release") {
      isDebuggable = false
      isMinifyEnabled = false
      /* Nothing to shrink: the host is two files, and the game is assets rather than code. */
      if (driftKeystore != null) {
        signingConfig = signingConfigs.getByName("drift")
      }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  /* The game's own bundle is already compressed where it matters, and the container is streamed
     off disk by the loader — an APK that recompresses it would cost memory on every read. */
  androidResources {
    noCompress += listOf("drft", "ktx2", "webp", "png", "jpg", "ogg", "mp3", "wasm")
  }
}

dependencies {
  /*
   * The one dependency, and both halves of it are load-bearing: `WebViewAssetLoader` is what
   * serves the game from an https origin instead of file://, and `WebViewCompat`'s
   * document-start script is the mobile equivalent of the desktop preload.
   */
  implementation("androidx.webkit:webkit:1.12.1")
}
