import SwiftUI

@main
struct ChessNowWatchApp: App {
    @StateObject private var session = SessionStore.shared

    init() {
        SessionStore.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
        }
    }
}
