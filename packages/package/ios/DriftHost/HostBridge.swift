import UIKit
import WebKit

/// The half of the bridge that iOS can expose, which is less than Android's.
///
/// **There is no synchronous return from native code to JavaScript on this platform.** A
/// `WKScriptMessageHandler` is one-way; `WKScriptMessageHandlerWithReply` — iOS 14 and up, which
/// is why the deployment target is 15 — gives a promise back, and that is the most this can do. So
/// everything a game must read *synchronously* is injected before its first line of script runs,
/// as a literal object, and only the mutations arrive here.
///
/// `bridgeShim.ts`'s iOS half assembles both into the same `DriftHostBridge` the desktop shell
/// exposes, so the engine sees one seam with three shells behind it.
final class HostBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "driftHost"
    private static let storePrefix = "drift.store."

    private weak var controller: ViewController?
    private let defaults = UserDefaults.standard

    init(controller: ViewController) {
        self.controller = controller
    }

    /// Everything the page can read the instant it starts, as JSON for the injected literal.
    ///
    /// Rebuilt whenever the host has something new to say — a rotation, a display change — and
    /// pushed into the page by assigning over the same object, so a bridge that read it at boot is
    /// not left reporting the previous orientation for the rest of the session.
    func stateJson() -> String {
        var store: [String: String] = [:]
        for (key, value) in defaults.dictionaryRepresentation() {
            guard key.hasPrefix(Self.storePrefix), let text = value as? String else { continue }
            store[String(key.dropFirst(Self.storePrefix.count))] = text
        }

        let screen = controller?.view.window?.windowScene?.screen ?? UIScreen.main
        let bounds = screen.bounds
        // A real number, which is the whole point of a shell: 60 on most devices and 120 on a
        // ProMotion one, and a game pacing itself against a guess would be wrong on both.
        let hz = screen.maximumFramesPerSecond

        let state: [String: Any] = [
            "snapshot": store,
            "refreshHz": hz > 0 ? hz : NSNull(),
            "mode": "fullscreen",
            "size": ["width": Int(bounds.width), "height": Int(bounds.height)],
            "displays": [[
                "id": "0",
                "label": "built-in",
                "width": Int(bounds.width),
                "height": Int(bounds.height),
                "scale": screen.scale,
                "refreshHz": hz > 0 ? hz : NSNull(),
                "primary": true,
            ]],
            "fullscreen": true,
            // An iOS application does not exit itself and Apple asks that it not try, so a game
            // reads this and draws no exit button rather than one that does nothing.
            "canQuit": false,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any],
              let name = body["name"] as? String else {
            replyHandler(false, nil)
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]

        switch name {
        case "write":
            if let key = payload["key"] as? String, let value = payload["value"] as? String {
                defaults.set(value, forKey: Self.storePrefix + key)
            }
            replyHandler(true, nil)

        case "remove":
            if let key = payload["key"] as? String {
                defaults.removeObject(forKey: Self.storePrefix + key)
            }
            replyHandler(true, nil)

        case "fullscreen", "mode":
            // The status bar is the only thing there is to hide here, and the view controller
            // hides it for the whole life of the application. Answered rather than acted on.
            replyHandler(true, nil)

        case "save":
            save(payload: payload, reply: replyHandler)

        case "openExternal":
            if let raw = payload["url"] as? String, let url = URL(string: raw),
               ["http", "https", "mailto"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
            replyHandler(true, nil)

        default:
            replyHandler(false, "unknown message: \(name)")
        }
    }

    /// Write a file and offer it to the share sheet, which is where a file goes on this platform.
    ///
    /// **There is no Downloads folder to save into.** A clip that a player cannot send anywhere is
    /// a clip that does not exist, so the file is written to the app's temporary directory and
    /// handed straight to `UIActivityViewController` — Photos, Files, Messages, whatever they
    /// choose. The temporary copy is the system's to reclaim.
    private func save(payload: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let name = payload["name"] as? String,
              let pieces = payload["data"] as? [String] else {
            reply(false, nil)
            return
        }
        var bytes = Data()
        for piece in pieces {
            guard let part = Data(base64Encoded: piece) else {
                reply(false, nil)
                return
            }
            bytes.append(part)
        }

        let safe = name.replacingOccurrences(of: "/", with: "_")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safe)
        do {
            try bytes.write(to: url, options: .atomic)
        } catch {
            reply(false, nil)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let host = self?.controller else {
                reply(false, nil)
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // An iPad presents this from a point rather than from the bottom, and one with no
            // anchor throws rather than appearing.
            sheet.popoverPresentationController?.sourceView = host.view
            sheet.popoverPresentationController?.sourceRect = CGRect(
                x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
            host.present(sheet, animated: true)
            reply(true, nil)
        }
    }
}
