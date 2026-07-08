# Implementation Plan: ChessLens for iPhone (Local Execution)

Yes! You can run the entire ChessLens app **completely locally on your iPhone** without needing any external server. 

Because iOS is sandboxed, we cannot run a local Python Flask server in the background. Instead, we can run Stockfish directly inside the iOS app using one of two architectures:
1. **Hybrid WebAssembly Architecture (Recommended)**: Run the same HTML5/CSS/JS code in a native container (using Capacitor/Cordova or as a Progressive Web App) and replace the Python/Stockfish backend with **Stockfish.js (WebAssembly)** running directly inside the phone's browser/WebView.
2. **Native Swift Architecture**: Build a native iOS app in Swift and compile the Stockfish C++ code as a native iOS library that links directly with Xcode.

Here is the detailed plan to build and deploy ChessLens locally to your iPhone using your Apple Developer Membership.

---

## Architecture Comparison

### Option A: WebAssembly + Capacitor (Fastest & Simplest)
*   **How it works**: We bundle our existing frontend (HTML, CSS, JS, Chessboard.js) into a native iOS app shell using **CapacitorJS**. We replace the Flask backend calls with a local Web Worker running **Stockfish.js** (WebAssembly Stockfish compiled from C++).
*   **Pros**:
    *   Reuses 100% of our existing UI, wood themes, and CSS.
    *   No C++ compilation issues in Xcode.
    *   Fully local: runs offline inside the browser thread.
*   **Cons**: WebAssembly runs at ~70% of native speed, but modern iPhones (A15/A16/A17 chips) are so fast that a 12-depth Stockfish search takes under 50ms anyway.

### Option B: Native Swift + Compiled Stockfish C++ (Maximum Performance)
*   **How it works**: We build the interface natively in SwiftUI. We compile Stockfish's C++ source code for Apple Silicon (arm64 iOS) and use a Swift-to-C++ bridging header to send UCI commands to the local engine binary.
*   **Pros**:
    *   100% native CPU performance.
    *   Deep iOS integration (haptics, system widgets).
*   **Cons**: Requires building the chess board rendering, evaluation bars, and graphs from scratch in SwiftUI.

---

## Step-by-Step Deployment Roadmap (Option A: Capacitor)

Since you have an **Apple Developer Membership**, you can compile the app in Xcode and load it directly onto your iPhone as a development build.

### Phase 1: Adapt the Code for Client-Side execution
1.  **Integrate Stockfish WebAssembly**:
    *   Import `stockfish.js` (WebAssembly version) into the project assets.
    *   Initialize a browser Web Worker inside `app.js`:
        ```javascript
        const stockfish = new Worker('js/stockfish.js');
        ```
2.  **Redirect API endpoints**:
    *   Rewrite `fetch("/api/live_eval")` and `/api/analyze` to send UCI commands directly to the Web Worker via `stockfish.postMessage("position fen ...")`.
3.  **Local Cache**:
    *   Save cached analyses and game histories directly to the iPhone's `localStorage` or IndexedDB (which persist permanently inside the app container).

### Phase 2: Wrap as iOS App with Capacitor
1.  **Install Capacitor** in the project directory:
    ```bash
    npm install @capacitor/core @capacitor/cli
    npx cap init ChessLens com.yourname.chesslens --web-dir=static
    ```
2.  **Add the iOS Platform**:
    ```bash
    npm install @capacitor/ios
    npx cap add ios
    ```
3.  **Sync Web Assets**:
    *   Copies our HTML, CSS, JS, and chess textures into the Xcode project:
    ```bash
    npx cap sync
    ```

### Phase 3: Build & Run in Xcode
1.  **Open the project in Xcode**:
    ```bash
    npx cap open ios
    ```
2.  **Configure Code Signing**:
    *   In Xcode, select the `ChessLens` project root.
    *   Go to **Signing & Capabilities**.
    *   Check **"Automatically manage signing"**.
    *   Select your Apple Developer Account under **Team**.
3.  **Deploy to iPhone**:
    *   Plug your iPhone into your Mac using a cable.
    *   In Xcode's target dropdown, select your physical iPhone.
    *   Click the **Play/Build** button (or press `Cmd+R`).
    *   Xcode compiles the app, signs it with your developer certificate, and installs it directly on your iPhone.

---

## Verification Plan

### Manual Testing on iPhone
1.  **Offline Check**: Turn on Airplane Mode. Open ChessLens and run game analysis. Ensure Stockfish WASM executes moves locally on-device.
2.  **Performance Check**: Verify that live evaluations complete in under 100ms without heating up the phone or draining battery excessively.
3.  **Layout Responsiveness**: Test the wood-themed board and sidebar scrolling under vertical (portrait) and horizontal (landscape) rotations.
