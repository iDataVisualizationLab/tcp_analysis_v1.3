// src/rendering/arcPath.js
// Arc path generation

import { FLAG_CURVATURE } from '../config/constants.js';
import { classifyFlags } from '../tcp/flags.js';

/**
 * Generate SVG arc path for a link.
 * @param {Object} d - Link with source/target having x/y properties
 * @returns {string} - SVG path string
 */
export function linkArc(d) {
  if (!d || !d.source || !d.target) {
    console.warn('Invalid link object for arc:', d);
    return 'M0,0 L0,0';
  }
  const dx = d.target.x - d.source.x;
  const dy = d.target.y - d.source.y;
  const dr = Math.sqrt(dx * dx + dy * dy) / 2;
  if (d.source.y < d.target.y) {
    return "M" + d.source.x + "," + d.source.y + "A" + dr + "," + dr + " 0 0,1 " + d.target.x + "," + d.target.y;
  } else {
    return "M" + d.target.x + "," + d.target.y + "A" + dr + "," + dr + " 0 0,1 " + d.source.x + "," + d.source.y;
  }
}

/**
 * Generate gradient ID for a link.
 * @param {Object} d - Link object
 * @param {Function} sanitizeId - ID sanitizer function
 * @returns {string}
 */
export function gradientIdForLink(d, sanitizeId) {
  const src = d.sourceIp || (typeof d.source === 'string' ? d.source : d.source?.name);
  const tgt = d.targetIp || (typeof d.target === 'string' ? d.target : d.target?.name);
  return `grad-${sanitizeId(`${src}__${tgt}__${d.minute}`)}`;
}

// === Bar Diagram Arc Generator ===

/**
 * Generate curved arc path for bar diagram visualization.
 * Uses flag-based curvature to distinguish different packet types.
 * @param {Object} d - Packet data with timestamp, src_ip, dst_ip, flags
 * @param {Object} options - {xScale, ipPositions, pairs, findIPPosition, flagCurvature, srcY, dstY}
 * @returns {string} SVG path string
 */
export function arcPathGenerator(d, options) {
    const {
        xScale,
        ipPositions,
        pairs,
        findIPPosition,
        flagCurvature = FLAG_CURVATURE,
        srcY,  // Optional: actual source y position (with offset)
        dstY   // Optional: actual destination y position (with offset)
    } = options;

    if (!xScale || !ipPositions || !d) return "";

    // Handle missing required properties
    if (!d.src_ip || !d.dst_ip) return "";

    // Get timestamp from various possible fields (for pre-aggregated data)
    // For binned data, use binCenter to match circle positioning
    const timestamp = (d.binned && Number.isFinite(d.binCenter))
        ? d.binCenter
        : (d.timestamp ?? d.binStart ?? 0);
    const timestampInt = Math.floor(timestamp);
    const x = xScale(timestampInt);
    // Use provided y positions if available, otherwise fall back to baseline positions
    const y1 = srcY !== undefined ? srcY : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions);
    const y2 = dstY !== undefined ? dstY : findIPPosition(d.dst_ip, d.src_ip, d.dst_ip, pairs, ipPositions);

    if (y1 === 0 || y2 === 0 || y1 === y2) return "";

    // Curvature by TCP flag type (pixels of horizontal offset)
    const flagType = d.flagType || classifyFlags(d.flags);
    const base = (flagCurvature[flagType] !== undefined) ? flagCurvature[flagType] : flagCurvature.OTHER;
    const vert = Math.abs(y2 - y1);

    // Scale curvature slightly with vertical distance so long arcs remain visible
    const scale = Math.min(1, vert / 200);
    const dx = base * (0.5 + 0.5 * scale);

    // If no curvature for this flag, draw straight line
    if (dx <= 0) {
        return `M${x},${y1} L${x},${y2}`;
    }

    // Curve everything to the right regardless of direction
    const cx1 = x + dx;
    const cy1 = y1;
    const cx2 = x + dx;
    const cy2 = y2;

    return `M${x},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x},${y2}`;
}
