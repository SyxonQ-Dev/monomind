// ── Second Brain warm bridge: lazy singleton import of the compiled memory
// bridge (loads the local embedding model once for the server's lifetime).
// Boot-warmed below only when this project actually has a knowledge base.
let _knowledgeBridgePromise = null;
const _getKnowledgeBridge = () => {
  if (!_knowledgeBridgePromise) {
    _knowledgeBridgePromise = import('../memory/memory-bridge.js').catch((err) => {
      _knowledgeBridgePromise = null; // allow retry on next request
      if (process.env.MONOMIND_DEBUG)
        console.error('[knowledge] bridge import failed:', err.message);
      return null;
    });
  }
  return _knowledgeBridgePromise;
};

export { _getKnowledgeBridge };
