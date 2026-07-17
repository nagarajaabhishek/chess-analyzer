import Foundation

struct NewGameResponse: Codable {
    let gameId: String
    let fen: String
    let playerColor: String
    let botElo: Int
    let whitePlayer: String
    let blackPlayer: String
    let botSan: String?
    let speech: String?

    enum CodingKeys: String, CodingKey {
        case gameId = "game_id"
        case fen
        case playerColor = "player_color"
        case botElo = "bot_elo"
        case whitePlayer = "white_player"
        case blackPlayer = "black_player"
        case botSan = "bot_san"
        case speech
    }
}

struct GameStateResponse: Codable {
    let gameId: String
    let fen: String
    let pgn: String
    let turn: String
    let result: String
    let playerColor: String?
    let hintsUsed: Int
    let hintsLeft: Int
    let lastMoveSan: String?

    enum CodingKeys: String, CodingKey {
        case gameId = "game_id"
        case fen, pgn, turn, result
        case playerColor = "player_color"
        case hintsUsed = "hints_used"
        case hintsLeft = "hints_left"
        case lastMoveSan = "last_move_san"
    }
}

struct MoveResponse: Codable {
    let status: String
    let playedSan: String?
    let playedUci: String?
    let botSan: String?
    let botUci: String?
    let fen: String?
    let result: String?
    let gameOver: Bool?
    let speech: String?
    let hintsLeft: Int?
    let candidates: [String]?

    enum CodingKeys: String, CodingKey {
        case status
        case playedSan = "played_san"
        case playedUci = "played_uci"
        case botSan = "bot_san"
        case botUci = "bot_uci"
        case fen, result
        case gameOver = "game_over"
        case speech
        case hintsLeft = "hints_left"
        case candidates
    }
}

struct ControlResponse: Codable {
    let status: String
    let result: String?
    let fen: String?
    let speech: String?
}

struct HintResponse: Codable {
    let hintSan: String?
    let speech: String?
    let hintsLeft: Int?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case hintSan = "hint_san"
        case speech
        case hintsLeft = "hints_left"
        case status
    }
}

struct APIErrorResponse: Codable {
    let error: String
}

enum ChessFEN {
    /// FEN's active-color field ("w"/"b") is the source of truth for whose turn it is —
    /// simpler and less error-prone than re-deriving it from move counts client-side.
    static func turn(of fen: String) -> String {
        let parts = fen.split(separator: " ")
        guard parts.count > 1 else { return "white" }
        return parts[1] == "b" ? "black" : "white"
    }
}
