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
