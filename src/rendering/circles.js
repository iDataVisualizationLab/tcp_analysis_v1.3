// src/rendering/circles.js
// Circle rendering for packet visualization

import { getFlagType } from '../tcp/flags.js';

/**
 * Create IP pair key from src and dst IPs (alphabetically ordered for consistency).
 * @param {string} srcIp - Source IP
 * @param {string} dstIp - Destination IP
 * @returns {string} Canonical IP pair key
 */
function makeIpPairKey(srcIp, dstIp) {
    if (!srcIp || !dstIp) return 'unknown';
    return srcIp < dstIp ? `${srcIp}<->${dstIp}` : `${dstIp}<->${srcIp}`;
}

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
        ROW_GAP,
        ipRowHeights,
        ipPairCounts,
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

    // Collect unique IP pairs per row (yPos) with earliest timestamp for ordering
    const items = (binned || []).filter(d => d);
    const ipPairsByRow = new Map(); // yPos -> Map(ipPairKey -> earliestTimestamp)
    for (const d of items) {
        const yPos = d.yPos !== undefined ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions);
        const ipPairKey = makeIpPairKey(d.src_ip, d.dst_ip);
        if (!ipPairsByRow.has(yPos)) {
            ipPairsByRow.set(yPos, new Map());
        }
        const pairMap = ipPairsByRow.get(yPos);
        const timestamp = d.binCenter || d.binTimestamp || d.timestamp || Infinity;
        if (!pairMap.has(ipPairKey) || timestamp < pairMap.get(ipPairKey)) {
            pairMap.set(ipPairKey, timestamp);
        }
    }

    // Create ordered list of IP pairs per row, sorted by earliest timestamp
    const ipPairOrderByRow = new Map(); // yPos -> Map(ipPairKey -> index)
    for (const [yPos, pairTimestamps] of ipPairsByRow) {
        // Sort pairs by their earliest timestamp
        const orderedPairs = Array.from(pairTimestamps.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([pair]) => pair);
        const orderMap = new Map();
        orderedPairs.forEach((pair, idx) => orderMap.set(pair, idx));
        ipPairOrderByRow.set(yPos, { order: orderMap, count: orderedPairs.length });
    }

    // Layout constants
    const DEFAULT_ROW_HEIGHT = ROW_GAP || 30;
    const SUB_ROW_GAP = 2; // Gap between sub-rows

    // Helper function to calculate y position with offset for an IP pair on a given row
    const calculateYPosWithOffset = (ip, ipPairKey) => {
        const baseY = ipPositions.get(ip);
        if (baseY === undefined) return null;

        const pairInfo = ipPairOrderByRow.get(baseY) || { order: new Map(), count: 1 };
        const pairIndex = pairInfo.order.get(ipPairKey) || 0;
        const pairCount = pairInfo.count;

        const rowHeight = (ipRowHeights && ipRowHeights.get(ip)) || DEFAULT_ROW_HEIGHT;
        const availableHeight = Math.max(20, rowHeight - 6);
        const totalGaps = Math.max(0, pairCount - 1) * SUB_ROW_GAP;
        const subRowHeight = Math.max(4, (availableHeight - totalGaps) / pairCount);

        return baseY + pairIndex * (subRowHeight + SUB_ROW_GAP);
    };

    // Ensure each item has yPos and calculate offset
    const processed = items.map((d, idx) => {
        const yPos = d.yPos !== undefined ? d.yPos : findIPPosition(d.src_ip, d.src_ip, d.dst_ip, pairs, ipPositions);
        const ipPairKey = makeIpPairKey(d.src_ip, d.dst_ip);
        const pairInfo = ipPairOrderByRow.get(yPos) || { order: new Map(), count: 1 };
        const pairIndex = pairInfo.order.get(ipPairKey) || 0;
        const pairCount = pairInfo.count;

        // Get this IP's row height (dynamic per-IP)
        const rowHeight = (ipRowHeights && ipRowHeights.get(d.src_ip)) || DEFAULT_ROW_HEIGHT;
        const availableHeight = Math.max(20, rowHeight - 6);

        // Calculate sub-row height based on how many pairs share this row
        const totalGaps = Math.max(0, pairCount - 1) * SUB_ROW_GAP;
        const subRowHeight = Math.max(4, (availableHeight - totalGaps) / pairCount);

        // First pair (pairIndex 0) aligns with baseline (yPos) where label is
        // Subsequent pairs grow DOWNWARD from there
        const pairCenterY = yPos + pairIndex * (subRowHeight + SUB_ROW_GAP);

        return {
            ...d,
            yPos,
            yPosWithOffset: pairCenterY,
            ipPairKey,
            ipPairs: d.ipPairs || [{ src_ip: d.src_ip, dst_ip: d.dst_ip, count: d.count || 1 }],
            _idx: idx
        };
    });

    // Key function
    const getDataKey = d => {
        if (d.binned) {
            const flagStr = d.flagType || d.flag_type || getFlagType(d);
            return `bin_${Math.floor(d.binCenter || d.timestamp)}_${Math.round(d.yPos)}_${flagStr}_${d._idx}`;
        }
        return `${d.src_ip}-${d.dst_ip}-${d.timestamp}-${d.src_port || 0}-${d.dst_port || 0}_${d._idx}`;
    };

    // Helper to get flag color
    const getFlagColor = d => {
        const flagStr = d.flagType || d.flag_type || getFlagType(d);
        return flagColors[flagStr] || flagColors.OTHER;
    };

    layer.selectAll('.direction-dot')
        .data(processed, getDataKey)
        .join(
            enter => enter.append('circle')
                .attr('class', d => `direction-dot ${d.binned && d.count > 1 ? 'binned' : ''}`)
                .attr('r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('data-orig-r', d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN)
                .attr('fill', getFlagColor)
                .attr('cx', d => xScale(Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp)))
                .attr('cy', d => d.yPosWithOffset)
                .style('cursor', 'pointer')
                .on('mouseover', (event, d) => {
                    const dot = d3.select(event.currentTarget);
                    dot.classed('highlighted', true).style('stroke', '#000').style('stroke-width', '2px');
                    const baseR = +dot.attr('data-orig-r') || +dot.attr('r') || RADIUS_MIN;
                    dot.attr('r', baseR);
                    const pairsToArc = d.ipPairs || [{ src_ip: d.src_ip, dst_ip: d.dst_ip }];
                    pairsToArc.forEach(p => {
                        // Calculate actual y positions with offsets for both source and destination
                        const pairKey = makeIpPairKey(p.src_ip, p.dst_ip);
                        const srcY = calculateYPosWithOffset(d.src_ip, pairKey) || d.yPosWithOffset;
                        const dstY = calculateYPosWithOffset(p.dst_ip, pairKey);
                        const arcOpts = { xScale, ipPositions, pairs, findIPPosition, flagCurvature: FLAG_CURVATURE, srcY, dstY };
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
                .attr('cy', d => d.yPosWithOffset)
                .style('cursor', 'pointer')
        );
}
