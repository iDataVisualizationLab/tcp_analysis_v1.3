/**
 * Bifocal Display Transform Module
 *
 * Divides timeline into three regions with piecewise linear mapping:
 * 1. Left context: [0, focusStart] -> [0, leftContextWidth]
 * 2. Focus region: [focusStart, focusEnd] -> [leftContextWidth, leftContextWidth + focusWidth]
 * 3. Right context: [focusEnd, 1] -> [leftContextWidth + focusWidth, 1]
 *
 * Preserves monotonicity (order-preserving) for all transform operations.
 */

/**
 * Core bifocal transform: maps normalized time [0,1] to screen position [0,1]
 *
 * @param {number} t - Normalized time value [0, 1]
 * @param {Object} state - Bifocal state object with focusStart, focusEnd, widths
 * @returns {number} - Normalized screen position [0, 1]
 */
export function bifocalTransform(t, state) {
  const { focusStart, focusEnd, leftContextWidth, focusWidth, rightContextWidth } = state;

  // Clamp input to valid range
  t = Math.max(0, Math.min(1, t));

  // Left context region: [0, focusStart] -> [0, leftContextWidth]
  if (t <= focusStart) {
    if (focusStart === 0) return 0;
    return (t / focusStart) * leftContextWidth;
  }

  // Focus region: [focusStart, focusEnd] -> [leftContextWidth, leftContextWidth + focusWidth]
  if (t <= focusEnd) {
    const focusRange = focusEnd - focusStart;
    if (focusRange === 0) return leftContextWidth;
    const localT = (t - focusStart) / focusRange;
    return leftContextWidth + localT * focusWidth;
  }

  // Right context region: [focusEnd, 1] -> [leftContextWidth + focusWidth, 1]
  const rightRange = 1 - focusEnd;
  if (rightRange === 0) return leftContextWidth + focusWidth;
  const localT = (t - focusEnd) / rightRange;
  return leftContextWidth + focusWidth + localT * rightContextWidth;
}

/**
 * Inverse bifocal transform: maps screen position [0,1] back to time [0,1]
 * Used for click-to-time conversion and interaction handling
 *
 * @param {number} s - Normalized screen position [0, 1]
 * @param {Object} state - Bifocal state object
 * @returns {number} - Normalized time value [0, 1]
 */
export function bifocalInverse(s, state) {
  const { focusStart, focusEnd, leftContextWidth, focusWidth, rightContextWidth } = state;

  // Clamp input to valid range
  s = Math.max(0, Math.min(1, s));

  // Left context region
  if (s <= leftContextWidth) {
    if (leftContextWidth === 0) return 0;
    return (s / leftContextWidth) * focusStart;
  }

  // Focus region
  const focusEndScreen = leftContextWidth + focusWidth;
  if (s <= focusEndScreen) {
    if (focusWidth === 0) return focusStart;
    const localS = (s - leftContextWidth) / focusWidth;
    return focusStart + localS * (focusEnd - focusStart);
  }

  // Right context region
  if (rightContextWidth === 0) return focusEnd;
  const localS = (s - focusEndScreen) / rightContextWidth;
  return focusEnd + localS * (1 - focusEnd);
}

/**
 * Compute layout widths from compression ratio and focus bounds
 * Ensures widths sum to 1.0
 *
 * @param {Object} state - Bifocal state with focusStart, focusEnd, compressionRatio
 * @returns {Object} - { leftContextWidth, focusWidth, rightContextWidth }
 */
export function computeLayoutWidths(state) {
  const { focusStart, focusEnd, compressionRatio } = state;

  const focusRange = focusEnd - focusStart;
  const leftRange = focusStart;
  const rightRange = 1 - focusEnd;

  // Total "virtual" width if focus has weight 1 and context has weight 1/compressionRatio
  const leftVirtualWidth = leftRange / compressionRatio;
  const focusVirtualWidth = focusRange;
  const rightVirtualWidth = rightRange / compressionRatio;
  const totalVirtual = leftVirtualWidth + focusVirtualWidth + rightVirtualWidth;

  if (totalVirtual === 0) {
    return { leftContextWidth: 0, focusWidth: 1, rightContextWidth: 0 };
  }

  return {
    leftContextWidth: leftVirtualWidth / totalVirtual,
    focusWidth: focusVirtualWidth / totalVirtual,
    rightContextWidth: rightVirtualWidth / totalVirtual
  };
}

/**
 * Update bifocal state from focus region drag
 * Clamps values to valid ranges and recomputes layout widths
 *
 * @param {Object} state - Current bifocal state
 * @param {number} newFocusStart - New normalized focus start [0, 1]
 * @param {number} newFocusEnd - New normalized focus end [0, 1]
 * @returns {Object} - Updated state with recomputed layout widths
 */
export function updateFocusRegion(state, newFocusStart, newFocusEnd) {
  // Minimum focus region width (5% of timeline)
  const MIN_FOCUS_WIDTH = 0.05;

  // Clamp values
  newFocusStart = Math.max(0, Math.min(1 - MIN_FOCUS_WIDTH, newFocusStart));
  newFocusEnd = Math.max(newFocusStart + MIN_FOCUS_WIDTH, Math.min(1, newFocusEnd));

  // Update state
  const newState = {
    ...state,
    focusStart: newFocusStart,
    focusEnd: newFocusEnd
  };

  // Recompute layout widths
  const widths = computeLayoutWidths(newState);
  return { ...newState, ...widths };
}

/**
 * Create a bifocal X scale function compatible with existing xScaleLens interface
 *
 * @param {Object} params - Scale parameters
 * @param {Function} params.xScale - Base D3 time scale
 * @param {number} params.tsMin - Minimum timestamp
 * @param {number} params.tsMax - Maximum timestamp
 * @param {number} params.xStart - Pixel start position
 * @param {number} params.xEnd - Pixel end position
 * @param {Function} params.toDate - Timestamp to Date converter
 * @param {Function} params.getBifocalEnabled - Returns bifocal enabled state
 * @param {Function} params.getBifocalState - Returns bifocal state object
 * @param {Function} params.getXEnd - Optional dynamic xEnd getter
 * @returns {Function} - Scale function: timestamp -> pixel position
 */
export function createBifocalXScale(params) {
  const {
    xScale,
    tsMin,
    tsMax,
    xStart,
    xEnd,
    toDate,
    getBifocalEnabled,
    getBifocalState,
    getXEnd
  } = params;

  return (timestamp) => {
    const minX = xStart;
    const maxX = getXEnd ? getXEnd() : xEnd;
    const totalWidth = maxX - minX;

    // If bifocal disabled, use linear scale
    if (!getBifocalEnabled()) {
      const rawX = xScale(toDate(timestamp));
      return Math.max(minX, Math.min(rawX, maxX));
    }

    // Handle edge case: empty time range
    if (tsMax === tsMin) return minX;

    // Normalize timestamp to [0, 1]
    const normalized = (timestamp - tsMin) / (tsMax - tsMin);

    // Apply bifocal transform
    const state = getBifocalState();
    const position = bifocalTransform(normalized, state);

    // Map to pixel space
    const rawX = minX + position * totalWidth;
    return Math.max(minX, Math.min(rawX, maxX));
  };
}

/**
 * Create inverse scale for click-to-timestamp conversion
 *
 * @param {Object} params - Same as createBifocalXScale
 * @returns {Function} - Inverse scale: pixel position -> timestamp
 */
export function createBifocalXScaleInverse(params) {
  const { tsMin, tsMax, xStart, xEnd, getBifocalEnabled, getBifocalState, getXEnd } = params;

  return (pixelX) => {
    const minX = xStart;
    const maxX = getXEnd ? getXEnd() : xEnd;
    const totalWidth = maxX - minX;

    if (totalWidth === 0) return tsMin;

    // Normalize pixel to [0, 1]
    const normalizedScreen = (pixelX - minX) / totalWidth;

    // If bifocal disabled, linear inverse
    if (!getBifocalEnabled()) {
      return tsMin + normalizedScreen * (tsMax - tsMin);
    }

    // Apply inverse bifocal transform
    const state = getBifocalState();
    const normalizedTime = bifocalInverse(normalizedScreen, state);

    return tsMin + normalizedTime * (tsMax - tsMin);
  };
}
