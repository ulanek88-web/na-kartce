/* Worker trybu offline: liczy ruchy bota (CPU) poza głównym wątkiem – działa bez serwera. */
importScripts('/shared/engines.js');
self.onmessage = (e) => {
  const j = e.data;
  try { const eng = self.NKEngines.make(j.engine, j.params); self.postMessage({ id: j.id, move: eng.ai(j.state, j.level) }); }
  catch (x) { self.postMessage({ id: j.id, error: String(x && x.message || x) }); }
};
