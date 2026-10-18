/**
 * Observation / action interface between the authoritative engine and SLAI (GDD 12.4).
 * The same JSON shapes are validated by the Python service (slai/schema.py). Observations carry ONLY information
 * the team may legitimately know: own state, current sightings, timestamped last-known records (<= 3 s), static terrain.
 */
export const OBS_SCHEMA = 'gangup.obs.v1';
export const ACT_SCHEMA = 'gangup.act.v1';
//# sourceMappingURL=schema.js.map