import UIKit

/// The application, which is one window holding one view controller.
///
/// No storyboard: a game has one screen and a storyboard for it is a file nobody reads and a merge
/// conflict nobody wants. The launch screen is declared in the generated Info.plist as an empty
/// `UILaunchScreen`, which gives a black screen for the moment before the first frame — the same
/// thing the desktop shell's splash covers, and the most iOS offers without a bundled image.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
