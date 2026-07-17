import SwiftUI

struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @StateObject private var game = GameViewModel()

    var body: some View {
        Group {
            if !session.isLoggedIn {
                WaitingForPhoneView()
            } else if game.gameId == nil {
                NewGameView(game: game)
            } else {
                GameView(game: game)
            }
        }
    }
}

private struct WaitingForPhoneView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone.gen3")
                .font(.largeTitle)
            Text("Open ChessNow on your iPhone to sign in")
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
