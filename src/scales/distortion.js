// src/scales/distortion.js
// Fisheye and lens distortion functions
// Now includes D3 fisheye plugin support with Cartesian distortion

import { fisheyeScale, createCartesianFisheye } from '../plugins/d3-fisheye.js';

/**
 * Apply 1D lens transformation.
 * Expands a band around center, compresses outside.
 * @param {number} normalized - Input (0-1)
 * @param {number} lensCenterNorm - Center (0-1)
 * @param {number} bandRadiusNorm - Radius (0-1)
 * @param {number} magnification - Magnification factor
 * @returns {number}
 */
export function applyLens1D(normalized, lensCenterNorm, bandRadiusNorm, magnification) {
  const n = Math.min(1, Math.max(0, normalized));
  const c = Math.min(1, Math.max(0, lensCenterNorm));
  const r = Math.max(0, bandRadiusNorm);
  
  if (magnification <= 1 || r === 0) return n;
  
  const a = Math.max(0, c - r);
  const b = Math.min(1, c + r);
  const insideLength = Math.max(0, b - a);
  const outsideLength = a + (1 - b);
  
  if (insideLength === 0 || outsideLength < 0) return n;
  
  const scale = 1 / (outsideLength + insideLength * magnification);
  
  if (n < a) {
    return n * scale;
  } else if (n > b) {
    const base = scale * (a + insideLength * magnification);
    return base + (n - b) * scale;
  } else {
    const base = scale * a;
    return base + (n - a) * magnification * scale;
  }
}

/**
 * Create lens-aware X scale function.
 * @param {Object} params
 * @returns {Function}
 */
export function createLensXScale(params) {
  const { 
    xScale, tsMin, tsMax, xStart, xEnd, toDate,
    getIsLensing, getLensCenter, getLensingMul,
    getHorizontalFisheyeScale, getFisheyeEnabled,
    getXEnd // Optional getter for dynamic xEnd value
  } = params;
  
  return (timestamp) => {
    const minX = xStart;
    // Use getter if provided, otherwise fall back to static xEnd
    const maxX = getXEnd ? getXEnd() : xEnd;
    const currentXEnd = maxX;
    
    // Use horizontal fisheye if enabled
    if (getFisheyeEnabled() && getHorizontalFisheyeScale()) {
      const fisheyeX = getHorizontalFisheyeScale().apply(timestamp);
      return Math.max(minX, Math.min(fisheyeX, maxX));
    }
    
    if (!getIsLensing()) {
      const rawX = xScale(toDate(timestamp));
      return Math.max(minX, Math.min(rawX, maxX));
    }
    
    if (tsMax === tsMin) {
      const rawX = xScale(toDate(timestamp));
      return Math.max(minX, Math.min(rawX, maxX));
    }
    
    const normalized = (timestamp - tsMin) / (tsMax - tsMin);
    const totalWidth = currentXEnd - xStart;
    const lensCenterNorm = (getLensCenter() - tsMin) / (tsMax - tsMin);
    const bandRadiusNorm = 0.045;
    
    const position = applyLens1D(normalized, lensCenterNorm, bandRadiusNorm, getLensingMul());
    const rawX = minX + position * totalWidth;
    return Math.max(minX, Math.min(rawX, maxX));
  };
}

/**
 * Fisheye distortion function (monotonicity-preserving).
 * @param {number} t - Input (0-1)
 * @param {number} focus - Focus point (0-1)
 * @param {number} distortion - Distortion factor
 * @returns {number}
 */
export function fisheyeDistort(t, focus, distortion) {
  if (distortion <= 1) return t;
  
  const delta = t - focus;
  const distance = Math.abs(delta);
  const sign = delta < 0 ? -1 : 1;
  
  if (distance < 0.0001) return t;
  
  const effectRadius = 0.5;
  let scale;
  
  if (distance < effectRadius) {
    const normalized = distance / effectRadius;
    const blend = (1 - Math.cos(normalized * Math.PI)) / 2;
    scale = distortion - (distortion - 1) * blend;
  } else {
    const excessDistance = distance - effectRadius;
    const compressionFactor = 1 / distortion;
    scale = 1 - (1 - compressionFactor) * Math.min(1, excessDistance / (1 - effectRadius));
  }
  
  const distorted = focus + sign * distance * scale;
  return Math.max(0, Math.min(1, distorted));
}

/**
 * Create vertical fisheye scale.
 * @param {Object} params
 * @returns {Object}
 */
export function createFisheyeScale(params) {
  const { sortedIps, originalPositions, marginTop, innerHeight, getDistortion } = params;
  
  return {
    _focus: marginTop + innerHeight / 2,
    _sortedIps: sortedIps,
    
    focus(f) { this._focus = f; return this; },
    
    distortion(d) {
      if (arguments.length === 0) return getDistortion();
      return this;
    },
    
    apply(ip) {
      const idx = this._sortedIps.indexOf(ip);
      if (idx === -1) return originalPositions.get(ip) || marginTop;
      
      const originalY = originalPositions.get(ip);
      if (!originalY) return marginTop;
      
      const t = (originalY - marginTop) / innerHeight;
      const focusT = (this._focus - marginTop) / innerHeight;
      const distortedT = fisheyeDistort(t, focusT, getDistortion());
      
      return marginTop + distortedT * innerHeight;
    }
  };
}

/**
 * Region-based linear fisheye distortion that preserves monotonicity.
 * Maps normalized time [0,1] to distorted normalized position [0,1].
 * Ensures order is preserved: if t1 < t2, then distorted(t1) < distorted(t2).
 * @param {number} t - Input (0-1)
 * @param {number} focus - Focus point (0-1)
 * @param {number} distortion - Distortion factor
 * @returns {number}
 */
export function horizontalFisheyeDistort(t, focus, distortion) {
  if (distortion <= 1) return t;

  // Clamp input to valid range
  t = Math.max(0, Math.min(1, t));
  focus = Math.max(0, Math.min(1, focus));

  // Effect radius around focus (fraction of total range)
  const effectRadius = 0.15; // 15% on each side of focus = 30% total magnified region

  // Define regions: [0, focusLeft], [focusLeft, focusRight], [focusRight, 1]
  const focusLeft = Math.max(0, focus - effectRadius);
  const focusRight = Math.min(1, focus + effectRadius);

  // Calculate how much space each region should occupy after distortion
  // The magnified region expands, other regions compress to compensate
  const magnifiedWidth = focusRight - focusLeft;
  const leftWidth = focusLeft;
  const rightWidth = 1 - focusRight;

  // Total "virtual" width if we expand magnified region by distortion factor
  const virtualWidth = leftWidth + magnifiedWidth * distortion + rightWidth;

  // Normalize back to [0,1] range - each region gets proportional space
  const leftTargetWidth = leftWidth / virtualWidth;
  const magnifiedTargetWidth = (magnifiedWidth * distortion) / virtualWidth;
  const rightTargetWidth = rightWidth / virtualWidth;

  // Map t to output position based on which region it's in
  if (t <= focusLeft) {
    // Left region: compress linearly
    if (leftWidth === 0) return 0;
    const localT = t / leftWidth; // Normalize to [0,1] within region
    return localT * leftTargetWidth;
  } else if (t <= focusRight) {
    // Magnified region: expand linearly
    if (magnifiedWidth === 0) return leftTargetWidth;
    const localT = (t - focusLeft) / magnifiedWidth; // Normalize to [0,1] within region
    return leftTargetWidth + localT * magnifiedTargetWidth;
  } else {
    // Right region: compress linearly
    if (rightWidth === 0) return leftTargetWidth + magnifiedTargetWidth;
    const localT = (t - focusRight) / rightWidth; // Normalize to [0,1] within region
    return leftTargetWidth + magnifiedTargetWidth + localT * rightTargetWidth;
  }
}

/**
 * Create horizontal fisheye scale for timeline.
 * Uses region-based linear distortion that properly preserves monotonicity.
 * @param {Object} params
 * @returns {Object}
 */
export function createHorizontalFisheyeScale(params) {
  const { xStart, xEnd, tsMin, tsMax, getDistortion } = params;
  
  return {
    _focus: xStart + (xEnd - xStart) / 2,
    _xStart: xStart,
    _xEnd: xEnd,
    _tsMin: tsMin,
    _tsMax: tsMax,
    
    focus(f) { this._focus = f; return this; },
    
    distortion(d) {
      if (arguments.length === 0) return getDistortion();
      return this;
    },
    
    apply(timestamp) {
      const xStart = this._xStart;
      const xEnd = this._xEnd;
      const tsMin = this._tsMin;
      const tsMax = this._tsMax;
      const totalWidth = xEnd - xStart;
      
      if (totalWidth <= 0 || tsMax === tsMin) return xStart;
      
      // Convert timestamp to normalized position [0, 1]
      const t = (timestamp - tsMin) / (tsMax - tsMin);
      
      // Apply fisheye distortion
      const focusX = this._focus;
      const focusT = (focusX - xStart) / totalWidth;
      const distortion = getDistortion();
      
      const distortedT = horizontalFisheyeDistort(t, focusT, distortion);
      
      return xStart + distortedT * totalWidth;
    }
  };
}

/**
 * Create D3 fisheye scale for horizontal (X-axis) distortion using the D3 fisheye plugin.
 * This uses the proper D3 fisheye plugin with Cartesian distortion.
 * @param {Object} params
 * @param {Function} params.xScale - D3 scale for X-axis (e.g., d3.scaleTime())
 * @param {number} params.distortion - Distortion factor (default: 3)
 * @param {Function} params.getDistortion - Optional getter function for dynamic distortion
 * @returns {Function} D3 fisheye scale function
 */
export function createD3FisheyeXScale(params) {
  const { xScale, distortion = 3, getDistortion } = params;
  
  // Create base fisheye scale
  let fisheyeX = fisheyeScale(xScale, getDistortion ? getDistortion() : distortion, 0);
  
  return function(timestamp) {
    // Update distortion if getter is provided
    if (getDistortion) {
      const currentDistortion = getDistortion();
      if (fisheyeX.distortion() !== currentDistortion) {
        fisheyeX = fisheyeScale(xScale, currentDistortion, fisheyeX.focus());
      }
    }
    
    // Apply fisheye to timestamp
    return fisheyeX(timestamp);
  };
}

/**
 * Create D3 fisheye scale for vertical (Y-axis) distortion using the D3 fisheye plugin.
 * This uses the proper D3 fisheye plugin with Cartesian distortion.
 * @param {Object} params
 * @param {Function} params.yScale - D3 scale for Y-axis (e.g., d3.scalePoint() or d3.scaleLinear())
 * @param {number} params.distortion - Distortion factor (default: 3)
 * @param {Function} params.getDistortion - Optional getter function for dynamic distortion
 * @returns {Function} D3 fisheye scale function
 */
export function createD3FisheyeYScale(params) {
  const { yScale, distortion = 3, getDistortion } = params;
  
  // Create base fisheye scale
  let fisheyeY = fisheyeScale(yScale, getDistortion ? getDistortion() : distortion, 0);
  
  return function(value) {
    // Update distortion if getter is provided
    if (getDistortion) {
      const currentDistortion = getDistortion();
      if (fisheyeY.distortion() !== currentDistortion) {
        fisheyeY = fisheyeScale(yScale, currentDistortion, fisheyeY.focus());
      }
    }
    
    // Apply fisheye to value
    return fisheyeY(value);
  };
}

/**
 * Create Cartesian fisheye scales for both X and Y axes using D3 fisheye plugin.
 * This is the recommended approach for implementing lensing with Cartesian distortion.
 * @param {Object} params
 * @param {Function} params.xScale - D3 scale for X-axis
 * @param {Function} params.yScale - D3 scale for Y-axis
 * @param {number} params.distortion - Distortion factor (default: 3)
 * @param {Function} params.getDistortion - Optional getter function for dynamic distortion
 * @returns {Object} Object with fisheyeX, fisheyeY, focus, and distortion methods
 */
export function createD3CartesianFisheye(params) {
  const { xScale, yScale, distortion = 3, getDistortion } = params;
  
  // Create fisheye scales
  let fisheyeX = fisheyeScale(xScale, getDistortion ? getDistortion() : distortion, 0);
  let fisheyeY = fisheyeScale(yScale, getDistortion ? getDistortion() : distortion, 0);
  
  return {
    fisheyeX: function(value) {
      // Update distortion if getter is provided
      if (getDistortion) {
        const currentDistortion = getDistortion();
        if (fisheyeX.distortion() !== currentDistortion) {
          fisheyeX = fisheyeScale(xScale, currentDistortion, fisheyeX.focus());
        }
      }
      return fisheyeX(value);
    },
    
    fisheyeY: function(value) {
      // Update distortion if getter is provided
      if (getDistortion) {
        const currentDistortion = getDistortion();
        if (fisheyeY.distortion() !== currentDistortion) {
          fisheyeY = fisheyeScale(yScale, currentDistortion, fisheyeY.focus());
        }
      }
      return fisheyeY(value);
    },
    
    focus: function(x, y) {
      if (x !== undefined) fisheyeX.focus(x);
      if (y !== undefined) fisheyeY.focus(y);
      return this;
    },
    
    distortion: function() {
      return getDistortion ? getDistortion() : distortion;
    }
  };
}
