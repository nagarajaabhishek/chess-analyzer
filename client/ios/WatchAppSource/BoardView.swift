import SwiftUI

/// Read-only 8x8 board rendered from a FEN string. All moves are voice-driven, so this
/// never needs to handle taps/drags — it just displays state and optionally tints the
/// from/to squares of the most recent move.
struct BoardView: View {
    let fen: String
    var highlightFrom: String? = nil
    var highlightTo: String? = nil
    var flipped: Bool = false

    /// pieceGrid[rankIndex][fileIndex] — rankIndex 0 = rank 1 ... 7 = rank 8, fileIndex 0 = a ... 7 = h.
    private var pieceGrid: [[Character?]] {
        var grid: [[Character?]] = Array(repeating: Array(repeating: nil, count: 8), count: 8)
        let placement = fen.split(separator: " ").first.map(String.init) ?? ""
        let fenRanks = placement.split(separator: "/") // fenRanks[0] = rank 8 ... fenRanks[7] = rank 1
        for (i, rankStr) in fenRanks.enumerated() where i < 8 {
            let rankIndex = 7 - i
            var fileIndex = 0
            for ch in rankStr {
                if let n = ch.wholeNumberValue {
                    fileIndex += n
                } else {
                    if fileIndex < 8 { grid[rankIndex][fileIndex] = ch }
                    fileIndex += 1
                }
            }
        }
        return grid
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<8, id: \.self) { displayRow in
                HStack(spacing: 0) {
                    ForEach(0..<8, id: \.self) { displayCol in
                        let rankIndex = flipped ? displayRow : (7 - displayRow)
                        let fileIndex = flipped ? (7 - displayCol) : displayCol
                        let squareName = "\(Character(UnicodeScalar(97 + fileIndex)!))\(rankIndex + 1)"
                        SquareView(
                            piece: pieceGrid[rankIndex][fileIndex],
                            isLight: (rankIndex + fileIndex) % 2 == 1,
                            isHighlighted: squareName == highlightFrom || squareName == highlightTo
                        )
                    }
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

private struct SquareView: View {
    let piece: Character?
    let isLight: Bool
    let isHighlighted: Bool

    private static let glyphs: [Character: String] = [
        "K": "♔", "Q": "♕", "R": "♖", "B": "♗", "N": "♘", "P": "♙",
        "k": "♚", "q": "♛", "r": "♜", "b": "♝", "n": "♞", "p": "♟"
    ]

    var body: some View {
        ZStack {
            (isLight ? Color(white: 0.82) : Color(white: 0.35))
            if isHighlighted {
                Color.yellow.opacity(0.45)
            }
            if let piece, let glyph = Self.glyphs[piece] {
                // The glyphs themselves are visually hollow (white) vs solid (black) —
                // no extra color needed, and forcing one risks invisible pieces on
                // same-toned squares.
                Text(glyph)
                    .font(.system(size: 14))
                    .minimumScaleFactor(0.5)
            }
        }
    }
}
