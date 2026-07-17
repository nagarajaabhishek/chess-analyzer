import SwiftUI

struct NewGameView: View {
    @ObservedObject var game: GameViewModel

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "crown.fill")
                .font(.largeTitle)
            Text("ChessNow")
                .font(.headline)
            if game.isLoading {
                ProgressView()
            } else {
                Button("New Game") {
                    game.startNewGame()
                }
            }
            if let error = game.errorMessage {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }
}
