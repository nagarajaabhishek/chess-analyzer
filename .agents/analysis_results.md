# UI Analysis: Missing Elements & Feature Gaps

Based on a side-by-side comparison of **ChessLens** (Image 1) and the native **Chess.com Analysis Panel** (Image 2), we have identified several missing elements, their primary product purposes, and implementation pathways.

---

## 🔍 Comparative Table

| Missing Element | Purpose | Implementation Pathway in ChessLens |
| :--- | :--- | :--- |
| **1. Material Advantage & Captured Pieces** | Displays list of captured pieces for each player and calculates the net material balance (e.g. `+1` pawn or `+3` knight). | Parse the current FEN in `goToMove()` to count missing pieces, then render them as miniature icons under the respective player cards. |
| **2. Chess Clocks / Timers** | Displays remaining time for both players to simulate the time constraints of the live game. | Extract `%clk` timestamps from the PGN move strings and update the clock values dynamically on each navigation ply. |
| **3. Move Classification Summary Pills** | Provides a quick breakdown of play quality (e.g., *1 Great*, *23 Best*, *19 Excellent*) right above the main Review button. | Aggregate the `cls` counts from the pre-calculated analysis data and display them in a horizontal flex pill row. |
| **4. Move-by-Move Time Spent Bars** | Visualizes time spent per move (e.g., `4.4s`, `19.9s`) directly in the moves list. | Parse the difference between successive `%clk` values in the PGN and render miniature vertical time-spent bars in the move grid rows. |
| **5. Player Country Flags** | Adds international branding/personalization to the player banners. | Fetch country metadata from Chess.com's public user API (or display flags parsed from PGN headers) next to the usernames. |

---

## 🛠️ Detailed Breakdown of High-Value Features

### 1. Captured Pieces & Net Material Imbalance
*   **Purpose**: Essential for players to instantly gauge who is winning materially and what pieces have been traded. In endgames, tracking pawns vs. pieces is critical for pawn promotion calculations.
*   **Design**: Mini-symbols (e.g., ♙ ♙ ♘ ♖) aligned horizontally under the names, with a green/gray numerical pill (e.g., `+1`) showing the advantage.

### 2. Chess Clocks & Time Management
*   **Purpose**: Blunders are frequently caused by time pressure (time trouble). Seeing the clock tick down as you review the moves explains *why* a blunder occurred.
*   **Design**: A clean rectangular clock widget next to the player names that updates to show the exact time remaining when that move was played.

### 3. Classification Summary Pills
*   **Purpose**: Gives the user an instant, satisfying overview of their game quality (how many brilliant, great, or best moves they executed) before diving into the detailed card.
*   **Design**: Three green/blue color-coded capsules positioned directly above the **"Game Review"** button in the sidebar.
