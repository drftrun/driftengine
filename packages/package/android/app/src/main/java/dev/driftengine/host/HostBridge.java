package dev.driftengine.host;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;
import android.util.DisplayMetrics;
import android.view.Display;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;

/**
 * The half of the bridge that Android can actually expose.
 *
 * <p><b>Flat, synchronous, and strings only.</b> {@code @JavascriptInterface} can pass strings,
 * numbers and booleans and nothing else — no promise, no object, no callback — so every compound
 * answer here is JSON and {@code bridgeShim.ts} on the other side turns this into the same
 * {@code DriftHostBridge} the desktop shell exposes. The engine sees one seam with three shells
 * behind it rather than three seams.
 *
 * <p><b>Everything that touches a window runs on the UI thread.</b> A {@code @JavascriptInterface}
 * method is called on a WebView worker thread, and touching a {@link android.view.Window} from
 * there throws — which reaches the page as a rejected call rather than as the crash it is.
 */
public final class HostBridge {
  private static final String TAG = "drift";
  private static final String STORE = "drift-store";

  private final MainActivity activity;
  private final WebView web;
  private final SharedPreferences store;
  private volatile boolean fullscreen = true;

  /* One save at a time: a game exports a clip, not four at once, and a second `saveBegin`
     abandons the first rather than interleaving two files into one stream. */
  private OutputStream saveStream = null;
  private Uri saveUri = null;
  private File saveFile = null;
  private String saveName = "";

  HostBridge(MainActivity activity, WebView web) {
    this.activity = activity;
    this.web = web;
    this.store = activity.getSharedPreferences(STORE, Context.MODE_PRIVATE);
  }

  @JavascriptInterface
  public String snapshot() {
    JSONObject out = new JSONObject();
    try {
      for (Map.Entry<String, ?> entry : store.getAll().entrySet()) {
        Object value = entry.getValue();
        if (value instanceof String) out.put(entry.getKey(), (String) value);
      }
    } catch (Exception ignored) {
      /* A store that will not serialise is a store the game starts without, which is the same
         degradation every other implementation of this seam makes. */
    }
    return out.toString();
  }

  @JavascriptInterface
  public void write(String key, String value) {
    store.edit().putString(key, value).apply();
  }

  @JavascriptInterface
  public void remove(String key) {
    store.edit().remove(key).apply();
  }

  @JavascriptInterface
  public boolean isFullscreen() {
    return fullscreen;
  }

  @JavascriptInterface
  public void setFullscreen(boolean on) {
    fullscreen = on;
    activity.runOnUiThread(() -> activity.applyImmersive(on));
  }

  @JavascriptInterface
  public String mode() {
    return fullscreen ? "fullscreen" : "windowed";
  }

  @JavascriptInterface
  public boolean setMode(String mode) {
    setFullscreen(!"windowed".equals(mode));
    return true;
  }

  /**
   * The display's real refresh rate, which is the whole point of having a shell.
   *
   * <p>A browser cannot report this at all and answers null. A phone knows, and on a phone it is
   * worth knowing: 60, 90 and 120 are all common on the same model line.
   */
  @JavascriptInterface
  public float refreshHz() {
    Display display = activity.getWindowManager().getDefaultDisplay();
    return display == null ? 0f : display.getRefreshRate();
  }

  @JavascriptInterface
  public String size() {
    DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
    JSONObject out = new JSONObject();
    try {
      /* Logical pixels, which is what the page measures itself in — the drawing surface in device
         pixels is `width * density` and belongs to the renderer rather than to this. */
      out.put("width", Math.round(metrics.widthPixels / metrics.density));
      out.put("height", Math.round(metrics.heightPixels / metrics.density));
    } catch (Exception ignored) {
      // An unserialisable size is not a reason to fail a boot.
    }
    return out.toString();
  }

  /**
   * Always false: a phone has no window to size.
   *
   * <p>Reporting the refusal is what lets a settings screen grey the control out, instead of
   * offering a resolution list that silently does nothing. A game that wants fewer pixels on a
   * phone changes its render scale, which is the engine's own {@code RenderQuality}.
   */
  @JavascriptInterface
  public boolean setSize(int width, int height) {
    return false;
  }

  /**
   * Whether {@code setSize} would do anything, asked without performing one.
   *
   * <p>The same answer and the same reason, so a settings screen can grey its control while it is
   * drawing rather than by resizing a window to find out. It is answered here beside
   * {@code setSize} on purpose: the day an Android host gains a resizable window — a foldable, a
   * desktop mode — the two move together, and a constant in the JavaScript shim would not have.
   */
  @JavascriptInterface
  public boolean canSetSize() {
    return false;
  }

  @JavascriptInterface
  public String displays() {
    DisplayMetrics metrics = activity.getResources().getDisplayMetrics();
    JSONArray out = new JSONArray();
    try {
      JSONObject one = new JSONObject();
      one.put("id", "0");
      one.put("label", "built-in");
      one.put("width", Math.round(metrics.widthPixels / metrics.density));
      one.put("height", Math.round(metrics.heightPixels / metrics.density));
      one.put("scale", metrics.density);
      float hz = refreshHz();
      one.put("refreshHz", hz > 0f ? (Object) hz : JSONObject.NULL);
      one.put("primary", true);
      out.put(one);
    } catch (Exception ignored) {
      // As above.
    }
    return out.toString();
  }

  /**
   * True: an Android activity can end itself, and {@code finish()} is how.
   *
   * <p>A game reads this before it draws an Exit button. iOS answers false — applications there do
   * not exit programmatically, and Apple's guidance is that they should not — so the same menu
   * shows the button on one platform and not the other without knowing which it is on.
   */
  @JavascriptInterface
  public boolean canQuit() {
    return true;
  }

  /**
   * Writing a file the player can find afterwards, in three calls.
   *
   * <p><b>This is what makes a clip export work at all here.</b> A game ends an export with an
   * anchor whose href is a `blob:` URL — the thing every browser understands — and a WebView with
   * no download listener drops it silently: the player taps save and nothing happens, with no
   * error anywhere. The listener in {@link MainActivity} catches it, the page reads its own blob,
   * and the bytes arrive here in chunks because the only thing this bridge can carry is a string.
   *
   * <p><b>MediaStore on API 29 and up, and no permission is asked for.</b> A file written through
   * it lands in the device's Downloads and is visible to every gallery and file manager. Below 29
   * that API cannot write outside the app without {@code WRITE_EXTERNAL_STORAGE}, and asking a
   * player for storage permission to save their own clip is a prompt nobody should have to
   * answer — so those devices get the app's own external files directory, which needs nothing and
   * is still reachable through a file manager. Stated because the two are genuinely different
   * places and somebody will go looking.
   */
  @JavascriptInterface
  public boolean saveBegin(String name, String mime) {
    saveAbort();
    String safe = (name == null || name.isEmpty()) ? "download" : name.replaceAll("[/\\\\]", "_");
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ContentResolver resolver = activity.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
        values.put(MediaStore.Downloads.MIME_TYPE, mime == null ? "application/octet-stream" : mime);
        /* Pending until the last chunk lands, so nothing indexes half a file. */
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        saveUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (saveUri == null) return false;
        saveStream = resolver.openOutputStream(saveUri);
      } else {
        File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || (!dir.exists() && !dir.mkdirs())) return false;
        saveFile = new File(dir, safe);
        saveStream = new FileOutputStream(saveFile);
      }
      saveName = safe;
      return saveStream != null;
    } catch (Exception cause) {
      Log.e(TAG, "could not start a save", cause);
      saveAbort();
      return false;
    }
  }

  @JavascriptInterface
  public boolean saveChunk(String base64) {
    if (saveStream == null || base64 == null) return false;
    try {
      saveStream.write(Base64.decode(base64, Base64.DEFAULT));
      return true;
    } catch (Exception cause) {
      Log.e(TAG, "could not write a chunk", cause);
      saveAbort();
      return false;
    }
  }

  @JavascriptInterface
  public String saveEnd() {
    if (saveStream == null) return "";
    String where;
    try {
      saveStream.flush();
      saveStream.close();
      if (saveUri != null) {
        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        activity.getContentResolver().update(saveUri, done, null, null);
        where = "Downloads/" + saveName;
      } else {
        where = saveFile == null ? saveName : saveFile.getAbsolutePath();
      }
    } catch (Exception cause) {
      Log.e(TAG, "could not finish a save", cause);
      saveAbort();
      return "";
    }
    saveStream = null;
    saveUri = null;
    saveFile = null;
    final String message = where;
    /* Told rather than left to be discovered: a save with no feedback is a save the player
       repeats, and then there are four copies of the same clip. */
    activity.runOnUiThread(
        () -> Toast.makeText(activity, "Saved to " + message, Toast.LENGTH_LONG).show());
    return where;
  }

  @JavascriptInterface
  public void saveAbort() {
    try {
      if (saveStream != null) saveStream.close();
    } catch (Exception ignored) {
      // Closing a stream that already failed is not worth reporting.
    }
    saveStream = null;
    if (saveUri != null) {
      try {
        /* A pending entry left behind is a zero-byte row in the player's Downloads for ever. */
        activity.getContentResolver().delete(saveUri, null, null);
      } catch (Exception ignored) {
        // Nothing better to do.
      }
      saveUri = null;
    }
    if (saveFile != null) {
      // The half-written file is deleted for the same reason.
      saveFile.delete();
      saveFile = null;
    }
  }

  @JavascriptInterface
  public void requestQuit() {
    activity.runOnUiThread(activity::finish);
  }

  /**
   * Open a link in the person's own browser.
   *
   * <p>The same rule the desktop shell follows and for the same reasons: their browser has their
   * session and a way back, and a WebView with no address bar showing somebody else's page is a
   * browser nobody is maintaining. The scheme filter is on the JavaScript side, in {@code
   * links.ts}, so both shells refuse the same set.
   */
  @JavascriptInterface
  public void openExternal(String url) {
    try {
      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      activity.startActivity(intent);
    } catch (Exception ignored) {
      /* No application to handle it, or a malformed URL. Nothing opens, and a game that cannot
         open a link is not a game that should stop. */
    }
  }
}
