import UIKit
import WebKit

/// One view controller, one `WKWebView`, and nothing else.
///
/// **The renderer here is WebKit and there is no choice about that.** Apple requires it for
/// anything that browses the web, so a bundled Chromium is not an option on this platform — which
/// is also why the engine's WebGL2 baseline matters: what the device offers is what the game gets,
/// and the acceptance probe decides whether WebGPU is among it.
///
/// **The bridge is injected at document start**, before the game's own scripts, the same timing
/// the desktop preload and Android's document-start script have. Everything readable synchronously
/// goes in as a literal; see `HostBridge` for why that is not a shortcut but the only shape this
/// platform allows.
final class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    private var bridge: HostBridge!

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()

        guard let root = Bundle.main.url(forResource: "www", withExtension: nil) else {
            assertionFailure("the game was not copied into the bundle; see ios.ts")
            return
        }
        let shell = Bundle.main.url(forResource: "shell", withExtension: nil) ?? root

        bridge = HostBridge(controller: self)

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            SchemeHandler(root: root, shell: shell), forURLScheme: SchemeHandler.scheme)
        // A game's own audio is not an autoplaying advert, and the engine's mixer starts on the
        // first input anyway — so the gesture requirement only ever delays the first sound.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let content = configuration.userContentController
        content.addScriptMessageHandler(bridge, contentWorld: .page, name: HostBridge.name)
        content.addUserScript(WKUserScript(
            source: "globalThis.__driftHostState = \(bridge.stateJson());",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        if let shim = Bundle.main.url(forResource: "drift-shim", withExtension: "js"),
           let source = try? String(contentsOf: shim, encoding: .utf8) {
            content.addUserScript(WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            // Loud rather than silent: the game runs and believes it is in a plain browser, which
            // is a defined state and a surprising one to debug from the outside.
            NSLog("[drift] the bridge shim is missing from the bundle; the game has no host")
        }

        web = WKWebView(frame: view.bounds, configuration: configuration)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self
        web.uiDelegate = self
        // A game is not a document: rubber-banding at its edges reads as the whole screen coming
        // loose, and the scroll view is the only thing that does it.
        web.scrollView.bounces = false
        web.scrollView.isScrollEnabled = false
        web.isOpaque = false
        web.backgroundColor = .black
        view.backgroundColor = .black
        view.addSubview(web)

        /*
         * **`localhost`, not `app`.** The host is what makes this a secure context — see the note
         * in `SchemeHandler` — and the difference between the two is `crossOriginIsolated`,
         * `SharedArrayBuffer`, the wake lock, and everything else gated on one.
         */
        web.load(URLRequest(url: URL(string: "\(SchemeHandler.scheme)://localhost/index.html")!))
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // A rotation changes what the injected state says, and a bridge reading a stale object
        // would report the previous orientation for the rest of the session.
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self else { return }
            self.web.evaluateJavaScript(
                "Object.assign(globalThis.__driftHostState ?? {}, \(self.bridge.stateJson()))")
        }
    }

    /// A link to the outside opens in Safari, never inside the game.
    ///
    /// The same rule the desktop shell follows: their browser has their session, their bookmarks
    /// and a way back, and an in-app view is a browser nobody is maintaining. Only `http`, `https`
    /// and `mailto` leave at all.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == SchemeHandler.scheme {
            decisionHandler(.allow)
            return
        }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// `target="_blank"` arrives here rather than as a navigation, and goes the same way out.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
        return nil
    }
}
