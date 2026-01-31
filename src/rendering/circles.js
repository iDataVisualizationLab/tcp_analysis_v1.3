// src/rendering/circles.js
// Circle rendering for packet visualization

import { getFlagType } from '../tcp/flags.js';

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
        createTooltipHTML,
        FLAG_CURVATURE,
        d3
    } = options;

    if (!layer) return;

    // Clear bar segments in this layer
    try { layer.selectAll('.bin-bar-segment').remove(); } catch {}
    try { layer.selectAll('.bin-stack').remove(); } catch {}

    const tooltip = d3.select('#tooltip');

    // Merge bins that share the same x position, same source IP row, and same flag type
    // This combines different destination IPs on the same row at the same time
    const merged = mergeBinsByRow(binned, { findIPPosition, pairs, ipPositions });

    // Update rScale domain to reflect merged counts (may exceed pre-merge max)
    const mergedMax = merged.reduce((mx, d) => Math.max(mx, d.count || 1), 1);
    if (mergedMax > rScale.domain()[1]) {
        rScale.domain([1, mergedMax]);
    }

    // Key function: use binCenter + yPos + flagType (merges same-row bins)
    const getDataKey = d => {
        if (d.binned) {
            const flagStr = d.flagType || d.flag_type || getFlagType(d);
            return `bin_${Math.floor(d.binCenter || d.timestamp)}_${Math.round(d.yPos)}_${flagStr}`;
        }
        return `${d.src_ip}-${d.dst_ip}-${d.timestamp}-${d.src_port || 0}-${d.dst_port || 0}`;
    };

    // Helper to get flag color - prefer flagType string from pre-binned data
    const getFlagColor = d => {
        const flagStr = d.flagType || d.flag_type || getFlagType(d);
        return flagColors[flagStr] || flagColors.OTHER;
    };

    layer.selectAll('.direction-dot')
        .data(merged, getDataKey)
        .join(
            enter => enter.append('circle')
                .attr('class', d => `direction-dot ${d.binned && d.count > 1 ? 'binned' : ''}`)
                .attr('r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('data-orig-r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('fill', getFlagColor)
                .attr('cx', d => xScale(Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp)))
                .attr('cy', d => d.binned ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions))
                .style('cursor', 'pointer')
                .on('mouseover', (event, d) => {
                    const dot = d3.select(event.currentTarget);
                    dot.classed('highlighted', true).style('stroke', '#000').style('stroke-width', '2px');
                    const baseR = +dot.attr('data-orig-r') || +dot.attr('r') || RADIUS_MIN;
                    dot.attr('r', baseR);
                    // Draw arcs for all contributing IP pairs on this row
                    const pairsToArc = d.ipPairs || [{ src_ip: d.src_ip, dst_ip: d.dst_ip }];
                    const arcOpts = { xScale, ipPositions, pairs, findIPPosition, flagCurvature: FLAG_CURVATURE };
                    pairsToArc.forEach(p => {
                        const arcD = { src_ip: p.src_ip, dst_ip: p.dst_ip, binned: d.binned, binCenter: d.binCenter, timestamp: d.timestamp, flagType: d.flagType, flags: d.flags };
                        const arcPath = arcPathGenerator(arcD, arcOpts);
                        if (arcPath) {
                            mainGroup.append('path').attr('class', 'hover-arc').attr('d', arcPath)
                                .style('stroke', getFlagColor(d))
                                .style('stroke-width', '2px')
                                .style('stroke-opacity', 0.8).style('fill', 'none').style('pointer-events', 'none');
                        }
                    });
                    tooltip.style('display', 'block').html(createTooltipHTML(d));
                })
                .on('mousemove', e => { tooltip.style('left', `${e.pageX + 40}px`).style('top', `${e.pageY - 40}px`); })
                .on('mouseout', e => {
                    const dot = d3.select(e.currentTarget);
                    dot.classed('highlighted', false).style('stroke', null).style('stroke-width', null);
                    const baseR = +dot.attr('data-orig-r') || RADIUS_MIN; dot.attr('r', baseR);
                    mainGroup.selectAll('.hover-arc').remove(); tooltip.style('display', 'none');
                }),
            update => update
                .attr('class', d => `direction-dot ${d.binned && d.count > 1 ? 'binned' : ''}`)
                .attr('r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('data-orig-r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('fill', getFlagColor)
                .attr('cx', d => xScale(Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp)))
                .attr('cy', d => d.binned ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions))
                .style('cursor', 'pointer')
        );
}

/**
 * Merge bins on the same source IP row, same time bin, and same flag type.
 * Different destination IPs at the same (row, time, flag) become one circle
 * with an ipPairs array so hover can draw arcs to each destination.
 */
function mergeBinsByRow(binned, { findIPPosition, pairs, ipPositions }) {
    if (!binned || binned.length === 0) return binned;

    const mergeMap = new Map();

    for (const d of binned) {
        if (!d.binned) {
            // Non-binned (single packet) items pass through unmerged
            const key = `single_${d.src_ip}_${d.dst_ip}_${d.timestamp}_${d.src_port || 0}_${d.dst_port || 0}`;
            mergeMap.set(key, d);
            continue;
        }

        const flagStr = d.flagType || d.flag_type || 'OTHER';
        const binTime = Math.floor(d.binCenter || d.timestamp);
        // Key includes yPos (source IP row) so different rows stay separate
        const yPos = d.yPos !== undefined ? Math.round(d.yPos) : Math.round(findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions));
        const mergeKey = `${binTime}_${yPos}_${flagStr}`;

        if (!mergeMap.has(mergeKey)) {
            mergeMap.set(mergeKey, {
                ...d,
                yPos,
                count: d.count || 1,
                totalBytes: d.totalBytes || 0,
                originalPackets: d.originalPackets ? [...d.originalPackets] : [d],
                ipPairs: [{ src_ip: d.src_ip, dst_ip: d.dst_ip, count: d.count || 1 }]
            });
        } else {
            const existing = mergeMap.get(mergeKey);
            existing.count += (d.count || 1);
            existing.totalBytes = (existing.totalBytes || 0) + (d.totalBytes || 0);
            if (d.originalPackets) {
                existing.originalPackets = existing.originalPackets.concat(d.originalPackets);
            }
            // Only add if it's a different dst_ip (avoid duplicates)
            const pairKey = `${d.src_ip}_${d.dst_ip}`;
            const existingPair = existing.ipPairs.find(p => `${p.src_ip}_${p.dst_ip}` === pairKey);
            if (existingPair) {
                existingPair.count += (d.count || 1);
            } else {
                existing.ipPairs.push({ src_ip: d.src_ip, dst_ip: d.dst_ip, count: d.count || 1 });
            }
        }
    }

    return Array.from(mergeMap.values());
}
