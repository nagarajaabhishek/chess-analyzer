import Foundation
import WatchConnectivity

/// Forwards the logged-in user's phone + session token to the paired Watch app via
/// WatchConnectivity, so ChessNow Watch never needs its own OTP login screen — it just
/// inherits whatever session the iPhone app (client/static/app.js) already has.
final class WatchSessionRelay: NSObject, WCSessionDelegate {
    static let shared = WatchSessionRelay()

    private override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func relay(phone: String?, token: String?) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        guard let phone, let token, !phone.isEmpty, !token.isEmpty else { return }

        let context = WCSession.default.applicationContext
        if context["phone"] as? String == phone, context["token"] as? String == token {
            return
        }

        do {
            try WCSession.default.updateApplicationContext(["phone": phone, "token": token])
        } catch {
            print("WatchSessionRelay: failed to update application context: \(error)")
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
