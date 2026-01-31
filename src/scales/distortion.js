// src/scales/distortion.js
// Bifocal display transform functions

import { bifocalTransform } from './bifocal.js';

/**
 * Create bifocal-aware X scale function.
 * @param {Object} params
 * @returns {Function}
 */
export function createLensXScale(params) {
  const {
    xScale, tsMin, tsMax, xStart, xEnd, toDate,
    getBifocalEnabled, getBifocalState,
    getXEnd // Optional getter for dynamic xEnd value
  } = params;

  return (timestamp) => {
    const minX = xStart;
    // Use getter if provided, otherwise fall back to static xEnd
    const maxX = getXEnd ? getXEnd() : xEnd;
    const currentXEnd = maxX;
    const totalWidth = currentXEnd - xStart;

    // Bifocal display
    if (getBifocalEnabled && getBifocalEnabled()) {
      if (tsMax === tsMin) return minX;
      const normalized = (timestamp - tsMin) / (tsMax - tsMin);
      const state = getBifocalState();
      const position = bifocalTransform(normalized, state);
      const rawX = minX + position * totalWidth;
      return Math.max(minX, Math.min(rawX, maxX));
    }

    // Fallback: linear scale
    const rawX = xScale(toDate(timestamp));
    return Math.max(minX, Math.min(rawX, maxX));
  };
}
