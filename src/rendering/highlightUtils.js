// src/rendering/highlightUtils.js
// Shared link/node highlight logic used by both timearcs and force layout.

/**
 * Highlight a hovered link and dim all others.
 * @param {d3.Selection} allLinks - All link/arc path selection
 * @param {Object} hoveredDatum - Data bound to hovered element
 * @param {Element} hoveredElement - The DOM element being hovered
 * @param {Function} widthScale - Scale for link stroke width
 * @param {Object} d3ref - d3 module reference
 */
export function highlightHoveredLink(allLinks, hoveredDatum, hoveredElement, widthScale, d3ref) {
  allLinks.style('stroke-opacity', p => (p === hoveredDatum ? 1 : 0.3));
  const baseW = widthScale(Math.max(1, hoveredDatum.count));
  d3ref.select(hoveredElement)
    .attr('stroke-width', Math.max(3, baseW < 2 ? baseW * 3 : baseW * 1.5))
    .raise();
}

/**
 * Restore all links to default state.
 * @param {d3.Selection} allLinks - All link/arc path selection
 * @param {Function} widthScale - Scale for link stroke width
 */
export function unhighlightLinks(allLinks, widthScale) {
  allLinks
    .style('stroke-opacity', 0.6)
    .attr('stroke-width', d => widthScale(Math.max(1, d.count)));
}

/**
 * Get active IPs and attack color for a link datum.
 * Works with both timearcs arcs (sourceNode.name, attack/attack_group)
 * and force layout links (sourceIp, attackType).
 * @param {Object} linkDatum - Link data
 * @param {Function} colorForAttack - Function to get color for attack type
 * @param {string} [labelMode] - 'attack' or 'attack_group' (timearcs only)
 * @returns {{ activeIPs: Set<string>, attackColor: string }}
 */
export function getLinkHighlightInfo(linkDatum, colorForAttack, labelMode) {
  const sourceIp = linkDatum.sourceIp || linkDatum.sourceNode?.name;
  const targetIp = linkDatum.targetIp || linkDatum.targetNode?.name;
  const attackType = linkDatum.attackType
    || ((labelMode === 'attack_group' ? linkDatum.attack_group : linkDatum.attack) || 'normal');
  const activeIPs = new Set([sourceIp, targetIp]);
  const attackColor = colorForAttack(attackType);
  return { activeIPs, attackColor };
}

// Extract IP string from datum — handles both timearcs (string) and force layout (node object)
function ipFromDatum(d) {
  return typeof d === 'string' ? d : d.id;
}

/**
 * Highlight endpoint labels: bold, larger font, attack color for active IPs; dim others.
 * @param {d3.Selection} labelSelection - Text element selection
 * @param {Set<string>} activeIPs - IPs to highlight
 * @param {string} attackColor - Color for active labels
 */
export function highlightEndpointLabels(labelSelection, activeIPs, attackColor) {
  labelSelection
    .style('fill', d => activeIPs.has(ipFromDatum(d)) ? attackColor : '#343a40')
    .style('font-size', d => activeIPs.has(ipFromDatum(d)) ? '14px' : null)
    .attr('font-weight', d => activeIPs.has(ipFromDatum(d)) ? 'bold' : null);
}

/**
 * Restore endpoint labels to default styling.
 * @param {d3.Selection} labelSelection - Text element selection
 */
export function unhighlightEndpointLabels(labelSelection) {
  labelSelection
    .style('fill', '#343a40')
    .style('font-size', null)
    .attr('font-weight', null);
}

// --- Directional arrowhead on hover ---
// Draws a filled triangle at the target end of the hovered arc/line,
// oriented along the tangent so it follows the curve naturally.

/**
 * Compute a filled-triangle arrowhead polygon from two sample points.
 * p1 is "behind" (further from target), p2 is at the target.
 * Returns SVG polygon points string.
 */
function arrowTriangle(p1x, p1y, p2x, p2y, size, minHalfW = 0) {
  const dx = p2x - p1x;
  const dy = p2y - p1y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len; // unit vector toward target
  const uy = dy / len;
  const px = -uy;      // perpendicular
  const py = ux;

  const halfW = Math.max(size * 0.55, minHalfW);
  // base at p2 (arc endpoint), tip extends beyond
  const tipX = p2x + ux * size;
  const tipY = p2y + uy * size;
  const blX = p2x + px * halfW;
  const blY = p2y + py * halfW;
  const brX = p2x - px * halfW;
  const brY = p2y - py * halfW;
  return `${tipX},${tipY} ${blX},${blY} ${brX},${brY}`;
}

/**
 * Show directional arrowhead on a hovered timearcs arc path.
 * The arc is a semicircle between vertically-aligned points so the tangent
 * at both endpoints is exactly horizontal. The arrowhead points LEFT
 * (traffic always arrives from the rightward-bulging arc).
 * @param {d3.Selection} container - SVG selection to append the overlay to
 * @param {Element} pathElement - The hovered path DOM element
 * @param {Object} datum - Link datum with source/target node objects
 * @param {string} color - Arrow fill color
 */
export function showArcArrowhead(container, pathElement, datum, color) {
  removeArrowheads(container);

  const totalLen = pathElement.getTotalLength();
  if (totalLen < 1) return;

  const srcY = datum.source?.y ?? datum.sourceNode?.y ?? 0;
  const tgtY = datum.target?.y ?? datum.targetNode?.y ?? 0;
  const targetAtEnd = srcY < tgtY;

  // Get the target endpoint position on the arc
  const ep = targetAtEnd
    ? pathElement.getPointAtLength(totalLen)
    : pathElement.getPointAtLength(0);

  const ARROW_SIZE = 10;
  const g = container.append('g').attr('class', 'hover-arrowhead-group')
    .style('pointer-events', 'none');

  // Horizontal LEFT direction: p1 is 1px to the right of ep, p2 is ep
  g.append('polygon')
    .attr('points', arrowTriangle(ep.x + 1, ep.y, ep.x, ep.y, ARROW_SIZE))
    .attr('fill', color)
    .attr('opacity', 0.85);
}

/**
 * Show directional arrowhead on a hovered force-network line.
 * Computes direction from node positions, respecting parallel offset and traffic direction.
 * @param {d3.Selection} container - Group to append the overlay to (e.g. _centerG)
 * @param {Object} datum - Link datum with sourceNode, targetNode, parallelOffset, directionReversed
 * @param {string} color - Arrow fill color
 * @param {number} [targetRadius=0] - Radius of target node circle; arrow tip placed at edge
 * @param {number} [strokeWidth=0] - Hovered link stroke width; arrow scales to be wider
 * @returns {{ baseX: number, baseY: number } | null} Arrowhead base position for line trimming
 */
export function showLineArrowhead(container, datum, color, targetRadius = 0, strokeWidth = 0) {
  removeArrowheads(container);

  const sx = datum.sourceNode.x, sy = datum.sourceNode.y;
  const tx = datum.targetNode.x, ty = datum.targetNode.y;

  // Parallel offset (same calculation as _ticked)
  const dx = tx - sx, dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const pOff = datum.parallelOffset || 0;
  const nx = (-dy / len) * pOff;
  const ny = (dx / len) * pOff;

  // Arrow follows original traffic direction
  let fromX, fromY, toX, toY;
  if (datum.directionReversed) {
    fromX = tx + nx; fromY = ty + ny;
    toX = sx + nx; toY = sy + ny;
  } else {
    fromX = sx + nx; fromY = sy + ny;
    toX = tx + nx; toY = ty + ny;
  }

  const dlen = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);
  if (dlen < 1) return null;

  const ARROW_SIZE = Math.max(10, strokeWidth * 1.5);

  // Pull back the target point so the arrow TIP lands at the circle edge.
  // arrowTriangle places the base at p2 and extends the tip ARROW_SIZE beyond,
  // so we pull back by (targetRadius + ARROW_SIZE).
  if (targetRadius > 0) {
    const ux = (toX - fromX) / dlen;
    const uy = (toY - fromY) / dlen;
    toX -= ux * (targetRadius + ARROW_SIZE);
    toY -= uy * (targetRadius + ARROW_SIZE);
  }

  // Ensure arrow width is at least as wide as the stroke
  const minHalfW = strokeWidth > 0 ? strokeWidth / 2 + 2 : 0;

  const g = container.append('g').attr('class', 'hover-arrowhead-group')
    .style('pointer-events', 'none');

  g.append('polygon')
    .attr('points', arrowTriangle(fromX, fromY, toX, toY, ARROW_SIZE, minHalfW))
    .attr('fill', color)
    .attr('opacity', 0.85);

  return { baseX: toX, baseY: toY };
}

/**
 * Remove arrowhead overlays from a container.
 * @param {d3.Selection} container - SVG or group selection
 */
export function removeArrowheads(container) {
  container.selectAll('.hover-arrowhead-group').remove();
}
