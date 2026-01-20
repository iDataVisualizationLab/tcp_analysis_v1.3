// src/rendering/circles.js
// Circle rendering for packet visualization

import { classifyFlags } from '../tcp/flags.js';

/**
 * Render circles for binned items into a layer.
 * @param {Object} layer - D3 selection (g element)
 * @param {Array} binned - Binned packet data
 * @param {Object} options - Rendering options
 */
export function renderCircles(layer, binned, options) {
    const {
        xScale,
        rScale,
        flagColors,
        RADIUS_MIN,
        mainGroup,
        arcPathGenerator,
        findIPPosition,
        pairs,
        ipPositions,
        d3
    } = options;

    if (!layer) return;

    // Clear bar segments in this layer
    try { layer.selectAll('.bin-bar-segment').remove(); } catch {}
    try { layer.selectAll('.bin-stack').remove(); } catch {}

    const tooltip = d3.select('#tooltip');

    layer.selectAll('.direction-dot')
        .data(binned, d => d.binned
            ? `bin_${d.timestamp}_${d.yPos}_${d.flagType}`
            : `${d.src_ip}-${d.dst_ip}-${d.timestamp}`)
        .join(
            enter => enter.append('circle')
                .attr('class', d => `direction-dot ${d.binned && d.count > 1 ? 'binned' : ''}`)
                .attr('r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('data-orig-r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('fill', d => flagColors[d.binned ? d.flagType : classifyFlags(d.flags)] || flagColors.OTHER)
                .attr('cx', d => xScale(Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp)))
                .attr('cy', d => d.binned ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions))
                .style('cursor', 'pointer'),
            update => update
                .attr('class', d => `direction-dot ${d.binned && d.count > 1 ? 'binned' : ''}`)
                .attr('r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('data-orig-r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('fill', d => flagColors[d.binned ? d.flagType : classifyFlags(d.flags)] || flagColors.OTHER)
                .attr('cx', d => xScale(Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp)))
                .attr('cy', d => d.binned ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions))
                .style('cursor', 'pointer')
        );
}
