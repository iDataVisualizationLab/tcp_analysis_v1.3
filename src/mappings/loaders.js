// src/mappings/loaders.js
// Async map loading functions

/**
 * Load JSON file with cache disabled.
 * @param {string} path - Path to JSON file
 * @returns {Promise<Object>} Parsed JSON object
 */
async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Load IP mapping (id ↔ address).
 * @param {string} path - Path to IP map JSON file
 * @returns {Promise<Map<number, string>|null>} Map from ID to IP address, or null on failure
 */
export async function loadIpMap(path = './full_ip_map.json') {
  try {
    const obj = await loadJson(path);
    const rev = new Map();
    for (const [ip, id] of Object.entries(obj)) {
      const num = Number(id);
      if (Number.isFinite(num)) {
        rev.set(num, ip);
      }
    }
    console.log(`IP map loaded: ${rev.size} entries`);
    return rev;
  } catch (err) {
    console.warn('Failed to load IP map:', err);
    return null;
  }
}

/**
 * Load event type mapping.
 * @param {string} path - Path to event type mapping JSON file
 * @returns {Promise<Map<number, string>|null>} Map from ID to event name, or null on failure
 */
export async function loadEventTypeMap(path = './event_type_mapping.json') {
  try {
    const obj = await loadJson(path);
    const rev = new Map();
    for (const [name, id] of Object.entries(obj)) {
      const num = Number(id);
      if (Number.isFinite(num)) rev.set(num, name);
    }
    return rev;
  } catch (err) {
    console.warn('Failed to load event type map:', err);
    return null;
  }
}

/**
 * Load color mapping.
 * @param {string} path - Path to color mapping JSON file
 * @param {Function} canonicalize - Function to canonicalize names for lookup
 * @returns {Promise<{raw: Map|null, canonical: Map|null}>} Raw and canonical color maps
 */
export async function loadColorMapping(path, canonicalize) {
  try {
    const obj = await loadJson(path);
    const raw = new Map(Object.entries(obj));
    const canonical = new Map();
    for (const [name, col] of Object.entries(obj)) {
      canonical.set(canonicalize(name), col);
    }
    return { raw, canonical };
  } catch (err) {
    console.warn('Failed to load color mapping:', path, err);
    return { raw: null, canonical: null };
  }
}

/**
 * Load attack group mapping.
 * @param {string} path - Path to attack group mapping JSON file
 * @returns {Promise<Map<number, string>|null>} Map from ID to group name, or null on failure
 */
export async function loadAttackGroupMap(path = './attack_group_mapping.json') {
  try {
    const obj = await loadJson(path);
    const entries = Object.entries(obj);
    const rev = new Map();

    if (entries.length) {
      // Detect orientation: name->id or id->name
      let nameToId = 0, idToName = 0;
      for (const [k, v] of entries.slice(0, 10)) {
        if (typeof v === 'number') nameToId++;
        if (!isNaN(+k) && typeof v === 'string') idToName++;
      }

      if (nameToId >= idToName) {
        for (const [name, id] of entries) {
          const num = Number(id);
          if (Number.isFinite(num)) rev.set(num, name);
        }
      } else {
        for (const [idStr, name] of entries) {
          const num = Number(idStr);
          if (Number.isFinite(num) && typeof name === 'string') rev.set(num, name);
        }
      }
    }
    return rev;
  } catch (err) {
    console.warn('Failed to load attack group map:', err);
    return null;
  }
}

/**
 * Load all mappings concurrently.
 * @param {Function} canonicalize - Function to canonicalize names for color lookup
 * @returns {Promise<Object>} Object containing all loaded mappings
 */
export async function loadAllMappings(canonicalize) {
  const [ipMap, eventMap, colorMap, groupMap, groupColorMap] = await Promise.all([
    loadIpMap(),
    loadEventTypeMap(),
    loadColorMapping('./color_mapping.json', canonicalize),
    loadAttackGroupMap(),
    loadColorMapping('./attack_group_color_mapping.json', canonicalize),
  ]);

  return {
    ipIdToAddr: ipMap,
    attackIdToName: eventMap,
    colorByAttack: colorMap.canonical,
    rawColorByAttack: colorMap.raw,
    attackGroupIdToName: groupMap,
    colorByAttackGroup: groupColorMap.canonical,
    rawColorByAttackGroup: groupColorMap.raw,
  };
}
