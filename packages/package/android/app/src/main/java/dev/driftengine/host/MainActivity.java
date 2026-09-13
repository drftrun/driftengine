package dev.driftengine.host;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Toast;
import android.os.Message;
import android.security.NetworkSecurityPolicy;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.URLUtil;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Collections;

/**
 * One activity, one WebView, and nothing else.
 *
 * <p><b>The game is served from an https origin, not from file://.</b> ES modules, {@code fetch}
 * and workers all need an origin and {@code file://} is not one — a game loaded that way fails to
 * import its own modules, which reads as a broken build rather than as a missing origin.
 * {@link WebViewAssetLoader} maps {@code https://appassets.androidplatform.net/assets/} onto the
 * APK's assets, and an https origin is a secure context by definition, so
 * {@code crossOriginIsolated} and the APIs that depend on it are available without a loopback
 * server listening inside a game.
 *
 * <p><b>The bridge is injected before the game's own scripts run.</b> That is what
 * {@code addDocumentStartJavaScript} is for, and it is the mobile equivalent of the desktop
 * shell's preload. Where the WebView is too old to support it the game still runs — it simply
 * finds no bridge and uses the browser implementations of every capability, which is the same
 * thing it does in a tab.
 *
 * <p>Written in Java rather than Kotlin deliberately: the host is two files of glue, it needs no
 * language feature Kotlin has, and dropping the Kotlin plugin removes a toolchain download from
 * every machine that ever builds this.
 */
public final class MainActivity extends Activity {
  private static final String TAG = "drift";
  private static final String ORIGIN = "https://appassets.androidplatform.net";

  /*
   * In a directory of its own, because the game's own files sit at the asset root: a shim called
   * `drift-shim.js` there would be one filename away from being overwritten by a game that has one.
   */
  private static final String SHIM_ASSET = "drift-host/shim.js";

  /** How long a first back press counts for. Two seconds is the convention and it feels right. */
  private static final long DOUBLE_BACK_MS = 2000L;

  private WebView web;
  private HostBridge bridge;
  private long lastBackAt = 0L;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);

    /*
     * **Mounted at the root, not at a subdirectory, and that is not a detail.** A web build
     * references its own files absolutely — `/assets/index-abc.js` is what every Vite build emits
     * — so a game served from `/assets/www/` has every one of those resolve to nothing: the HTML
     * loads, the CSS and the script do not, and the page appears as unstyled text with no console
     * open to say why. Measured on a real device before it was fixed.
     */
    WebViewAssetLoader loader =
        new WebViewAssetLoader.Builder()
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

    web = new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    /* A game's own audio is not an autoplaying advert, and the engine's mixer starts on the first
       input anyway — so the gesture requirement only ever delays the first sound by one tap. */
    web.getSettings().setMediaPlaybackRequiresUserGesture(false);
    /* Without this a `target="_blank"` link does nothing at all — no navigation, no window, no
       error — which is indistinguishable from a broken link. With it, the request arrives at
       onCreateWindow below and is sent to the person's browser. */
    web.getSettings().setSupportMultipleWindows(true);
    /*
     * **Mixed content follows the manifest's cleartext policy, read back from the platform.**
     *
     * The game is served from an https origin (see the class comment), so it is a secure context,
     * and a WebView defaults to MIXED_CONTENT_NEVER_ALLOW — stricter than a browser tab, which
     * permits an insecure WebSocket from a secure page with a deprecation warning. A relay on a
     * LAN cannot hold a certificate, so a game that wants one asks for
     * `"android": { "cleartextTraffic": true }` and gets `usesCleartextTraffic="true"` in its
     * manifest. Without this line that flag would be half a permission: Android would allow the
     * socket and the renderer would still refuse it, which is the kind of disagreement nobody can
     * debug from either side.
     *
     * **Read from NetworkSecurityPolicy rather than passed in as a build property**, so there is
     * one source of truth. The policy reflects `usesCleartextTraffic` and any network security
     * config a consumer adds later, so the two cannot drift apart and a scoped config keeps
     * working without this file learning about it.
     *
     * A build that asks for nothing keeps NEVER_ALLOW, which is exactly what it had before.
     */
    if (NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted()) {
      web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
    web.setWebViewClient(new LocalContentClient(loader, this));
    web.setWebChromeClient(new ExternalWindowClient(this));
    /*
     * **A WebView with no download listener drops a download silently**, and that is what a clip
     * export is: `offerClip` ends in an anchor with a `download` attribute pointing at a blob URL,
     * which every browser understands and this does not. The player taps save and nothing happens
     * at all — no dialog, no file, no error. Caught here and completed by the page, which is the
     * only thing that can read its own blob.
     */
    web.setDownloadListener(
        (url, userAgent, contentDisposition, mimeType, contentLength) ->
            startDownload(url, contentDisposition, mimeType));

    bridge = new HostBridge(this, web);
    web.addJavascriptInterface(bridge, "__driftHostNative");

    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      String shim = readAsset(SHIM_ASSET);
      if (shim != null) {
        WebViewCompat.addDocumentStartJavaScript(web, shim, Collections.singleton(ORIGIN));
      }
    } else {
      /* Loud rather than silent: the game will run and will believe it is in a plain browser,
         which is a defined state and a surprising one to debug from the outside. */
      Log.w(TAG, "this WebView cannot run a document-start script; the host bridge is absent");
    }

    setContentView(web);
    /* The screen stays on: a game is watched rather than read, and a player holding a controller
       touches nothing for minutes at a time. */
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    applyImmersive(true);

    web.loadUrl(ORIGIN + "/index.html");
  }

  /**
   * Hide or show the system bars. Immersive is the state a game starts in.
   *
   * <p>Not called {@code setImmersive}: {@link Activity} already has one, with a different meaning
   * and a wider visibility, and overriding it by accident is a compile error at best.
   */
  void applyImmersive(boolean on) {
    Window window = getWindow();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(!on);
      WindowInsetsController controller = window.getInsetsController();
      if (controller != null) {
        if (on) {
          controller.hide(WindowInsets.Type.systemBars());
          controller.setSystemBarsBehavior(
              WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
          controller.show(WindowInsets.Type.systemBars());
        }
      }
      return;
    }
    /* API 26 to 29. Deprecated on newer releases and the only thing that works on these. */
    int flags =
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
    window.getDecorView().setSystemUiVisibility(on ? flags : View.SYSTEM_UI_FLAG_VISIBLE);
  }

  @Override
  protected void onResume() {
    super.onResume();
    pushFocus(true);
  }

  @Override
  protected void onPause() {
    /* Told on the way out rather than the way back, so a game can pause its simulation and mute
       its mixer while the person is somewhere else. */
    pushFocus(false);
    super.onPause();
  }

  /**
   * Back is offered to the game before it is allowed to close anything.
   *
   * <p><b>Closing outright is how a run is lost by a thumb.</b> There is no window manager on this
   * platform asking whether you meant it, and a game does not get a chance to save. So the gesture
   * goes to the page first — {@code back()} in the shim answers a registered quit handler, or
   * failing that turns it into the Escape key a pause menu is almost always bound to — and only
   * when the page says it did nothing does the host consider closing.
   *
   * <p><b>And then it asks twice.</b> Two presses inside two seconds, with a line on screen
   * between them: the convention every Android game uses, because the alternative is a single
   * gesture that ends a session with no way back.
   *
   * <p>It walks no history. In a single-page game that history is the game's own routing, and
   * stepping back through it is never what the gesture meant.
   */
  @Override
  public void onBackPressed() {
    if (web == null) {
      finish();
      return;
    }
    web.evaluateJavascript(
        "String(Boolean(globalThis.__driftHostEvents && globalThis.__driftHostEvents.back()))",
        value -> {
          if ("\"true\"".equals(value) || "true".equals(value)) return;
          confirmExit();
        });
  }

  /** Two presses inside {@link #DOUBLE_BACK_MS}, with a line on screen between them. */
  private void confirmExit() {
    long now = SystemClock.elapsedRealtime();
    if (now - lastBackAt < DOUBLE_BACK_MS) {
      finish();
      return;
    }
    lastBackAt = now;
    Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
  }

  private void pushFocus(boolean focused) {
    if (web == null) return;
    web.evaluateJavascript(
        "globalThis.__driftHostEvents && globalThis.__driftHostEvents.focus(" + focused + ")", null);
  }

  /**
   * Send a link to the person's own browser, if it is one of the three schemes that may leave.
   *
   * <p>The same rule and the same three schemes as the desktop shell's {@code links.ts}: a
   * {@code file:} or a handler-registered scheme would hand the operating system a document or an
   * application with an argument, chosen by a page.
   */
  void openExternal(String url) {
    if (url == null) return;
    String lower = url.toLowerCase();
    boolean allowed =
        lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
    if (!allowed) return;
    if (bridge != null) bridge.openExternal(url);
  }

  /**
   * Complete a download the WebView reported.
   *
   * <p>A `blob:` URL belongs to the page and cannot be read from here, so it goes back to the page
   * and returns as bytes. Anything with a real scheme is somebody's server, and that is the
   * browser's job rather than this application's.
   */
  private void startDownload(String url, String contentDisposition, String mimeType) {
    if (url == null) return;
    if (!url.startsWith("blob:") && !url.startsWith("data:")) {
      openExternal(url);
      return;
    }
    String name = guessFileName(url, contentDisposition, mimeType);
    String script =
        "globalThis.__driftHostEvents && globalThis.__driftHostEvents.saveBlob("
            + jsString(url)
            + ","
            + jsString(name)
            + ")";
    web.evaluateJavascript(script, null);
  }

  /** What the file is called, in the order a browser decides it. */
  private static String guessFileName(String url, String contentDisposition, String mimeType) {
    try {
      String guessed = URLUtil.guessFileName(url, contentDisposition, mimeType);
      if (guessed != null && !guessed.isEmpty()) return guessed;
    } catch (Exception ignored) {
      // A blob URL carries no name, which is the common case and not an error.
    }
    return "download";
  }

  /** A JavaScript string literal, quoted and escaped, because this is built by concatenation. */
  private static String jsString(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  private String readAsset(String name) {
    try (InputStream in = getAssets().open(name)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int read;
      while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
      return out.toString("UTF-8");
    } catch (Exception cause) {
      Log.e(TAG, "could not read " + name, cause);
      return null;
    }
  }

  @Override
  protected void onDestroy() {
    if (web != null) web.destroy();
    super.onDestroy();
  }

  /** Serves the APK's assets through the loader, and sends everything else outside. */
  private static final class LocalContentClient extends WebViewClient {
    private final WebViewAssetLoader loader;
    private final MainActivity host;

    LocalContentClient(WebViewAssetLoader loader, MainActivity host) {
      this.loader = loader;
      this.host = host;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      return loader.shouldInterceptRequest(request.getUrl());
    }

    /**
     * A navigation away from the game opens in the person's browser instead.
     *
     * <p>Left inside the WebView it would replace the game with a web page that has no address
     * bar and no way back — the same reason the desktop shell refuses it.
     */
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      String url = request.getUrl().toString();
      if (url.startsWith(ORIGIN)) return false;
      host.openExternal(url);
      return true;
    }
  }

  /** `target="_blank"` and `window.open`, which arrive here rather than as a navigation. */
  private static final class ExternalWindowClient extends WebChromeClient {
    private final MainActivity host;

    ExternalWindowClient(MainActivity host) {
      this.host = host;
    }

    @Override
    public boolean onCreateWindow(
        WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
      /* The URL is not in the message — it is on the element that was hit, which is where a
         WebView keeps it for exactly this case. */
      WebView.HitTestResult hit = view.getHitTestResult();
      host.openExternal(hit == null ? null : hit.getExtra());
      /* False: no window is created, and the game carries on where it was. */
      return false;
    }
  }
}
