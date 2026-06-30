// Stockfish WASM worker — receives {wasmBinary} first, then UCI commands
self.onmessage = function (e) {
  if (e.data && e.data.wasmBinary) {
    self.Module = { wasmBinary: e.data.wasmBinary };
    self.onmessage = null;
    importScripts('/js/stockfish.js');
  }
};
