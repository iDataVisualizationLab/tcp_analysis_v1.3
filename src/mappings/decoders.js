// src/mappings/decoders.js
// IP and attack decoding functions

import { canonicalizeName } from '../utils/helpers.js';

/**
 * Decode IP value to dotted quad.
 * @param {*} value - IP ID or string
 * @param {Map|null} idToAddr - ID to IP map
 * @returns {string}
 */
export function decodeIp(value, idToAddr) {
  const v = (value ?? '').toString().trim();
  if (!v) return 'N/A';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return v;
  const n = Number(v);
  if (Number.isFinite(n) && idToAddr) {
    const ip = idToAddr.get(n);
    if (ip) return ip;
    console.warn(`IP ID ${n} not found in mapping`);
    return `IP_${n}`;
  }
  return v;
}

/**
 * Decode attack value to name.
 * @param {*} value - Attack ID or string
 * @param {Map|null} idToName - ID to name map
 * @returns {string}
 */
export function decodeAttack(value, idToName) {
  const v = (value ?? '').toString().trim();
  if (!v) return 'normal';
  const n = Number(v);
  if (Number.isFinite(n) && idToName) {
    return idToName.get(n) || 'normal';
  }
  return v;
}

/**
 * Decode attack group value.
 */
export function decodeAttackGroup(groupVal, fallbackVal, groupIdToName, attackIdToName) {
  const raw = (groupVal ?? '').toString().trim();
  if (!raw) {
    return decodeAttack(fallbackVal, attackIdToName);
  }
  const n = Number(raw);
  if (Number.isFinite(n) && groupIdToName) {
    return groupIdToName.get(n) || decodeAttack(fallbackVal, attackIdToName);
  }
  return raw;
}

/**
 * Look up color for attack name.
 */
export function lookupAttackColor(name, rawColorMap, canonicalColorMap) {
  if (!name) return null;
  if (rawColorMap && rawColorMap.has(name)) return rawColorMap.get(name);
  const key = canonicalizeName(name);
  if (canonicalColorMap && canonicalColorMap.has(key)) return canonicalColorMap.get(key);
  if (canonicalColorMap) {
    for (const [k, col] of canonicalColorMap.entries()) {
      if (k.includes(key) || key.includes(k)) return col;
    }
  }
  return null;
}

/**
 * Look up color for attack group name.
 */
export function lookupAttackGroupColor(name, rawColorMap, canonicalColorMap) {
  if (!name) return null;
  if (rawColorMap && rawColorMap.has(name)) return rawColorMap.get(name);
  const key = canonicalizeName(name);
  if (canonicalColorMap && canonicalColorMap.has(key)) return canonicalColorMap.get(key);
  if (canonicalColorMap) {
    for (const [k, col] of canonicalColorMap.entries()) {
      if (k.includes(key) || key.includes(k)) return col;
    }
  }
  return null;
}
