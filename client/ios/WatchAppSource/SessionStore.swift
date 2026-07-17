import Foundation
import WatchConnectivity

/// Receives the logged-in phone/token relayed from the paired iPhone app
/// (see client/ios/App/App/WatchSessionRelay.swift) — the Watch has no login screen
/// of its own, it just waits for this.
final class SessionStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = SessionStore()

    @Published private(set) var phone: String?
    @Published private(set) var token: String?

    private override init() {
        phone = UserDefaults.standard.string(forKey: "chessnow.phone")
        token = UserDefaults.standard.string(forKey: "chessnow.token")
        super.init()
    }

    var isLoggedIn: Bool { token != nil }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func store(phone: String?, token: String?) {
        guard let phone, let token, !phone.isEmpty, !token.isEmpty else { return }
        DispatchQueue.main.async {
            self.phone = phone
            self.token = token
            UserDefaults.standard.set(phone, forKey: "chessnow.phone")
            UserDefaults.standard.set(token, forKey: "chessnow.token")
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        if !context.isEmpty {
            store(phone: context["phone"] as? String, token: context["token"] as? String)
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        store(phone: applicationContext["phone"] as? String, token: applicationContext["token"] as? String)
    }
}
