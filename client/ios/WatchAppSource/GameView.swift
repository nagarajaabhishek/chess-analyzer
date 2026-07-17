import SwiftUI

struct GameView: View {
    @ObservedObject var game: GameViewModel
    @State private var moveText = ""
    @State private var showingActions = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                BoardView(
                    fen: game.fen,
                    highlightFrom: game.lastFromSquare,
                    highlightTo: game.lastToSquare,
                    flipped: game.playerColor == "black"
                )
                .padding(.horizontal, 4)

                Text(game.statusMessage)
                    .font(.caption2)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)

                if game.isGameOver {
                    Text(game.resultText)
                        .font(.headline)
                    Button("New Game") {
                        game.resetToNewGame()
                    }
                } else {
                    // Tapping this TextField hands off to watchOS's own full-screen text
                    // input controller (Scribble / dictation mic / keyboard) — no Speech
                    // framework or raw audio capture needed; it doesn't exist on watchOS.
                    TextField("Speak Move", text: $moveText)
                        .disabled(!game.isMyTurn || game.isLoading)
                        .onChange(of: moveText) { newValue in
                            guard !newValue.isEmpty else { return }
                            game.playMove(text: newValue)
                            moveText = ""
                        }

                    HStack {
                        Button("Hint (\(game.hintsLeft))") {
                            game.requestHint()
                        }
                        .disabled(game.hintsLeft <= 0 || game.isLoading)

                        // SwiftUI's Menu is unavailable on watchOS — confirmationDialog
                        // is the platform's equivalent for an action sheet.
                        Button("More") {
                            showingActions = true
                        }
                    }
                    .font(.caption2)
                    .confirmationDialog("Game Actions", isPresented: $showingActions) {
                        Button("Resign", role: .destructive) { game.control(action: "resign") }
                        Button("Offer Draw") { game.control(action: "draw") }
                        Button("Take Back") { game.control(action: "takeback") }
                        Button("Cancel", role: .cancel) {}
                    }
                }

                if let error = game.errorMessage {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.bottom, 8)
        }
    }
}
