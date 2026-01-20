// src/scales/scaleFactory.js
// Timestamp detection and D3 scale creation

/**
 * Detect timestamp unit from data range.
 * @param {number} tsMin - Minimum timestamp
 * @param {number} tsMax - Maximum timestamp
 * @returns {{ unit: string, looksAbsolute: boolean, unitMs: number, unitSuffix: string, base: number }}
 */
export function detectTimestampUnit(tsMin, tsMax) {
  const looksLikeMicroseconds = tsMin > 1e15;
  const looksLikeMilliseconds = tsMin > 1e12 && tsMin <= 1e15;
  const looksLikeSeconds = tsMin > 1e9 && tsMin <= 1e12;
  const looksLikeMinutesAbs = tsMin > 1e7 && tsMin <= 1e9;
  const looksLikeHoursAbs = tsMin > 1e5 && tsMin <= 1e7;
  const looksAbsolute = looksLikeMicroseconds || looksLikeMilliseconds || looksLikeSeconds || looksLikeMinutesAbs || looksLikeHoursAbs;
  
  let unit = 'minutes';
  if (looksLikeMicroseconds) unit = 'microseconds';
  else if (looksLikeMilliseconds) unit = 'milliseconds';
  else if (looksLikeSeconds) unit = 'seconds';
  else if (looksLikeMinutesAbs) unit = 'minutes';
  else if (looksLikeHoursAbs) unit = 'hours';
  
  const base = looksAbsolute ? 0 : tsMin;
  
  const unitMs = unit === 'microseconds' ? 0.001
              : unit === 'milliseconds' ? 1
              : unit === 'seconds' ? 1000
              : unit === 'minutes' ? 60_000
              : 3_600_000;
  
  const unitSuffix = unit === 'seconds' ? 's' : unit === 'hours' ? 'h' : 'm';
  
  return { unit, looksAbsolute, unitMs, unitSuffix, base };
}

/**
 * Create timestamp to Date converter.
 * @param {Object} timeInfo - From detectTimestampUnit
 * @returns {Function} - (timestamp) => Date
 */
export function createToDateConverter(timeInfo) {
  const { unit, looksAbsolute, unitMs, base } = timeInfo;
  
  return (m) => {
    if (m === undefined || m === null || !isFinite(m)) {
      console.warn('Invalid timestamp in toDate:', m);
      return new Date(0);
    }
    
    const val = looksAbsolute ? m : (m - base);
    const ms = unit === 'microseconds' ? (val / 1000)
             : unit === 'milliseconds' ? val
             : val * unitMs;
    
    const result = new Date(ms);
    if (!isFinite(result.getTime())) {
      console.warn('Invalid date result:', { m, looksAbsolute, unit, base, ms });
      return new Date(0);
    }
    return result;
  };
}

/**
 * Create X time scale.
 * @param {Object} d3 - D3 library
 * @param {Date} minDate
 * @param {Date} maxDate
 * @param {number} xStart
 * @param {number} xEnd
 * @returns {d3.ScaleTime}
 */
export function createTimeScale(d3, minDate, maxDate, xStart, xEnd) {
  return d3.scaleTime()
    .domain([minDate, maxDate])
    .range([xStart, xEnd]);
}

/**
 * Create Y point scale for IPs.
 * @param {Object} d3 - D3 library
 * @param {string[]} ips
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @param {number} padding
 * @returns {d3.ScalePoint}
 */
export function createIpScale(d3, ips, rangeStart, rangeEnd, padding = 0.5) {
  return d3.scalePoint()
    .domain(ips)
    .range([rangeStart, rangeEnd])
    .padding(padding);
}

/**
 * Create log scale for arc width.
 * @param {Object} d3 - D3 library
 * @param {number} minCount
 * @param {number} maxCount
 * @returns {d3.ScaleLog}
 */
export function createWidthScale(d3, minCount, maxCount) {
  const min = Math.max(1, minCount);
  const max = maxCount <= min ? min + 1 : maxCount;
  return d3.scaleLog().domain([min, max]).range([1, 4]);
}

/**
 * Calculate max arc radius for layout.
 * @param {Object[]} links
 * @param {Map} ipIndexMap - IP to index
 * @param {number} estimatedStep - Estimated Y step
 * @returns {number}
 */
export function calculateMaxArcRadius(links, ipIndexMap, estimatedStep) {
  let maxDist = 0;
  links.forEach(l => {
    const srcIdx = ipIndexMap.get(l.source);
    const tgtIdx = ipIndexMap.get(l.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      const dist = Math.abs(srcIdx - tgtIdx);
      if (dist > maxDist) maxDist = dist;
    }
  });
  return (maxDist * estimatedStep) / 2;
}
