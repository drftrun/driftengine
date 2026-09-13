import Foundation
import WebKit

/// Serves the game out of the app bundle over a scheme that is an origin.
///
/// **`file://` is not an origin**, and a game loaded from one fails to import its own modules —
/// which reads as a broken build rather than as a missing origin. A custom scheme handled here is
/// one, and it costs no listening socket inside a game.
///
/// **The host is `localhost`, and that is the whole of why this is a secure context.**
///
/// A custom scheme is *not* trustworthy to WebKit on its own. What rescues this one is the host:
/// W3C's "is origin potentially trustworthy" decides on the **host** before it considers any
/// scheme beyond https — step 4 returns trustworthy for a host in `127.0.0.0/8` or `::1/128`, and
/// step 5 for a host of `localhost`, and **neither step mentions the scheme**. So
/// `drift://localhost/…` is a secure context and `drift://app/…` is not, and the two differ by six
/// characters.
///
/// **Do not confuse this with the other well-known custom-scheme problem, which is real and is not
/// this one.** An `https://` page cannot fetch a subresource from a custom scheme — WebKit blocks
/// it as mixed content — and the workaround written up for that is `_registerURLSchemeAsSecure:`,
/// a private selector on `WKProcessPool` that risks a review rejection. That is a question about a
/// custom scheme used as a *subresource origin underneath an https document*. This is a question
/// about the *document's own* origin, and the answers are different. Nothing private is used here,
/// and nothing needs to be.
///
/// This is what Capacitor has shipped on iOS for years — `capacitor://localhost`, with their own
/// documentation recommending the hostname stay `localhost` precisely because it "allows the use of
/// Web APIs that would otherwise require a secure context". Millions of installed applications are
/// the evidence; no device here was needed to read it.
///
/// **So there is no loopback server**, which was the alternative this was going to cost: a
/// listening socket inside a game, a port that can be taken, and a permission prompt on some
/// platforms.
///
/// **The containment check is not optional.** A scheme handler that resolves a path and serves it
/// is a filesystem the page can walk, so every request is resolved and then checked to be inside
/// the bundle root — the same rule the desktop shell's `resolveWithinRoot` enforces.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "drift"

    /// The reserved prefix the packager's own assets are served under.
    ///
    /// One host rather than two, unlike the desktop shell's `app` and `shell`: a second host would
    /// not be `localhost`, and would therefore not be a secure context. A path prefix costs
    /// nothing and keeps the whole application on the one origin that is trustworthy.
    static let shellPrefix = "/__drift/"

    private let root: URL
    private let shell: URL

    init(root: URL, shell: URL) {
        self.root = root.standardizedFileURL
        self.shell = shell.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        let shellAsset = path.hasPrefix(Self.shellPrefix)
        let base = shellAsset ? shell : root
        let relative = shellAsset ? String(path.dropFirst(Self.shellPrefix.count - 1)) : path
        let resolved = base.appendingPathComponent(relative).standardizedFileURL

        // A prefix check on the string alone accepts a sibling directory whose name starts with
        // the root's; the separator is what makes this a directory check.
        guard resolved.path == base.path || resolved.path.hasPrefix(base.path + "/") else {
            task.didFailWithError(URLError(.noPermissionsToReadFile))
            return
        }

        guard let data = try? Data(contentsOf: resolved) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.contentType(for: resolved.pathExtension.lowercased()),
                "Content-Length": String(data.count),
                // The same policy the desktop shell serves: everything a game does is allowed and
                // a script from somewhere else is not.
                "Content-Security-Policy":
                    "default-src 'self' drift: blob: data:; "
                    + "script-src 'self' drift: blob: 'unsafe-inline' 'wasm-unsafe-eval'; "
                    + "style-src 'self' drift: 'unsafe-inline'; "
                    + "img-src 'self' drift: blob: data: https:; "
                    + "media-src 'self' drift: blob: data: https:; "
                    + "connect-src 'self' drift: blob: data: https: wss:",
            ]
        )!

        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Nothing is held between start and finish, so there is nothing to cancel.
    }

    /// **A wrong type is a silent load failure**, not a wrong picture: a module served as anything
    /// but JavaScript is refused by the loader, and an SVG served as bytes renders as a broken
    /// image — which is exactly how the desktop shell's splash failed once.
    static func contentType(for ext: String) -> String {
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "ktx2": return "image/ktx2"
        case "ogg": return "audio/ogg"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }
}
