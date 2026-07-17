import Foundation

private let startingFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

@MainActor
final class GameViewModel: ObservableObject {
    @Published var gameId: String?
    @Published var fen: String = startingFEN
    @Published var playerColor: String = "white"
    @Published var result: String = "*"
    @Published var hintsLeft: Int = 3
    @Published var statusMessage: String = ""
    @Published var lastFromSquare: String?
    @Published var lastToSquare: String?
    @Published var isLoading = false
    @Published var errorMessage: String?

    var turn: String { ChessFEN.turn(of: fen) }
    var isGameOver: Bool { result != "*" }
    var isMyTurn: Bool { !isGameOver && turn == playerColor }

    var resultText: String {
        switch result {
        case "1-0": return playerColor == "white" ? "You won!" : "Bot won"
        case "0-1": return playerColor == "black" ? "You won!" : "Bot won"
        case "1/2-1/2": return "Draw"
        case "aborted": return "Game aborted"
        default: return "Game over"
        }
    }

    func startNewGame() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let resp = try await APIClient.shared.newGame()
                gameId = resp.gameId
                fen = resp.fen
                playerColor = resp.playerColor
                result = "*"
                hintsLeft = 3
                statusMessage = resp.speech ?? "Your move."
                Speech.shared.speak(resp.speech ?? "Your move.")
                isLoading = false
            } catch {
                errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
                isLoading = false
            }
        }
    }

    func playMove(text: String) {
        guard let gameId else { return }
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let resp = try await APIClient.shared.move(gameId: gameId, text: text)
                isLoading = false
                applyMoveResponse(resp)
            } catch {
                isLoading = false
                errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func applyMoveResponse(_ resp: MoveResponse) {
        switch resp.status {
        case "ok":
            if let fen = resp.fen { self.fen = fen }
            if let result = resp.result { self.result = result }
            if let hintsLeft = resp.hintsLeft { self.hintsLeft = hintsLeft }
            highlightLastMove(botUci: resp.botUci, playedUci: resp.playedUci)
            statusMessage = resp.speech ?? ""
            Speech.shared.speak(resp.speech ?? "")
        case "illegal":
            statusMessage = "Didn't catch a legal move — try again."
            Speech.shared.speak(statusMessage)
        case "ambiguous":
            statusMessage = "Which one? Include the starting square, like e2 to e4."
            Speech.shared.speak(statusMessage)
        case "not_your_turn":
            statusMessage = "Not your turn yet."
        default:
            statusMessage = "Didn't catch that — try again."
        }
    }

    private func highlightLastMove(botUci: String?, playedUci: String?) {
        let uci = botUci ?? playedUci
        guard let uci, uci.count >= 4 else { return }
        lastFromSquare = String(uci.prefix(2))
        lastToSquare = String(uci.dropFirst(2).prefix(2))
    }

    func requestHint() {
        guard let gameId else { return }
        Task {
            do {
                let resp = try await APIClient.shared.hint(gameId: gameId)
                if let hintsLeft = resp.hintsLeft { self.hintsLeft = hintsLeft }
                statusMessage = resp.speech ?? "No hints left."
                Speech.shared.speak(statusMessage)
            } catch {
                errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    func control(action: String) {
        guard let gameId else { return }
        Task {
            do {
                let resp = try await APIClient.shared.control(gameId: gameId, action: action)
                if let fen = resp.fen { self.fen = fen }
                if let result = resp.result { self.result = result }
                statusMessage = resp.speech ?? ""
                Speech.shared.speak(statusMessage)
            } catch {
                errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    func resetToNewGame() {
        gameId = nil
        fen = startingFEN
        result = "*"
        lastFromSquare = nil
        lastToSquare = nil
        statusMessage = ""
    }
}
