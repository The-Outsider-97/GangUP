/** A fresh id for one game. Assigned by whoever starts the match (client, headless runner); the deterministic engine never makes one. */
export function newEpisodeId() {
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID();
    return 'ep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
//# sourceMappingURL=episode.js.map