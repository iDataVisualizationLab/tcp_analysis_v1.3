// src/rendering/circles.js
// Circle rendering for packet visualization

import { getFlagType } from '../tcp/flags.js';

// Canonical flag ordering for vertical separation (TCP lifecycle order)
const FLAG_PHASE_ORDER = [
    'SYN', 'SYN+ACK',
    'ACK', 'PSH', 'PSH+ACK',
    'FIN', 'FIN+ACK',
    'RST', 'RST+ACK',
    'OTHER'
];
const FLAG_ORDER_MAP = new Map(FLAG_PHASE_ORDER.map((f, i) => [f, i]));

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
        stableIpPairOrderByRow,
        mainGroup,
        arcPathGenerator,
        findIPPosition,
        pairs,
        ipPositions,
        createTooltipHTML,
        FLAG_CURVATURE,
        d3,
        separateFlags = false,
        onCircleHighlight = null,
        onCircleClearHighlight = null
    } = options;

    if (!layer) return;

    // Clear bar segments in this layer
    try { layer.selectAll('.bin-bar-segment').remove(); } catch {}
    try { layer.selectAll('.bin-stack').remove(); } catch {}

    const tooltip = d3.select('#tooltip');

    const items = (binned || []).filter(d => d);

    // Use stable pair ordering if provided (prevents row jumping on zoom),
    // otherwise fall back to computing from visible data
    let ipPairOrderByRow = stableIpPairOrderByRow;
    if (!ipPairOrderByRow || ipPairOrderByRow.size === 0) {
        // Fallback: compute from visible data
        const ipPairsByRow = new Map();
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
        ipPairOrderByRow = new Map();
        for (const [yPos, pairTimestamps] of ipPairsByRow) {
            const orderedPairs = Array.from(pairTimestamps.entries())
                .sort((a, b) => a[1] - b[1])
                .map(([pair]) => pair);
            const orderMap = new Map();
            orderedPairs.forEach((pair, idx) => orderMap.set(pair, idx));
            ipPairOrderByRow.set(yPos, { order: orderMap, count: orderedPairs.length });
        }
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
        // Preserve '__collapsed__' sentinel from collapseSubRowsBins so highlighting works
        const ipPairKey = d.ipPairKey === '__collapsed__' ? '__collapsed__' : makeIpPairKey(d.src_ip, d.dst_ip);
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

    // --- Flag separation: spread co-located flag circles vertically ---
    if (separateFlags) {
        // Group by (rounded binCenter, yPosWithOffset) to find overlapping circles
        const colocated = new Map();
        for (const d of processed) {
            const tKey = Math.floor(d.binned && Number.isFinite(d.binCenter) ? d.binCenter : d.timestamp);
            const key = `${tKey}|${Math.round(d.yPosWithOffset)}`;
            if (!colocated.has(key)) colocated.set(key, []);
            colocated.get(key).push(d);
        }
        for (const group of colocated.values()) {
            if (group.length <= 1) continue;
            // Sort by TCP lifecycle phase order
            group.sort((a, b) => {
                const fa = a.flagType || a.flag_type || getFlagType(a);
                const fb = b.flagType || b.flag_type || getFlagType(b);
                return (FLAG_ORDER_MAP.get(fa) ?? 99) - (FLAG_ORDER_MAP.get(fb) ?? 99);
            });
            // Determine available spread range (collapse-aware)
            const sample = group[0];
            const ip = sample.src_ip;
            const rowHeight = (ipRowHeights && ipRowHeights.get(ip)) || DEFAULT_ROW_HEIGHT;
            const availableHeight = Math.max(20, rowHeight - 6);
            let spreadRange;
            if (sample.ipPairKey === '__collapsed__') {
                // Collapsed: full row height is available
                spreadRange = availableHeight;
            } else {
                // Expanded: only this pair's sub-row slice
                const baseY = sample.yPos;
                const pairInfo = ipPairOrderByRow.get(baseY) || { count: 1 };
                const pairCount = pairInfo.count;
                const totalGaps = Math.max(0, pairCount - 1) * SUB_ROW_GAP;
                spreadRange = Math.max(4, (availableHeight - totalGaps) / pairCount);
            }
            const n = group.length;
            // Step: fit within spread range, capped so circles don't crowd.
            // Enforce minimum step of 2*RADIUS_MIN so circles never overlap
            // (may overflow sub-row bounds in expanded mode — acceptable trade-off).
            const maxRadius = Math.max(...group.map(d => d.binned && d.count > 1 ? rScale(d.count) : RADIUS_MIN));
            const step = Math.min(spreadRange / n, maxRadius * 2.5);
            const center = sample.yPosWithOffset;
            for (let i = 0; i < n; i++) {
                group[i].yPosWithOffset = center + (i - (n - 1) / 2) * step;
            }
        }
    }

    // Sort by radius descending so bigger circles render behind smaller ones
    processed.sort((a, b) => {
        const rA = a.binned && a.count > 1 ? rScale(a.count) : RADIUS_MIN;
        const rB = b.binned && b.count > 1 ? rScale(b.count) : RADIUS_MIN;
        return rB - rA;
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
                        // Source y: use circle's actual position (includes flag separation offset)
                        const pairKey = makeIpPairKey(p.src_ip, p.dst_ip);
                        const srcY = d.yPosWithOffset;
                        const dstY = calculateYPosWithOffset(p.dst_ip, pairKey);
                        const arcOpts = { xScale, ipPositions, pairs, findIPPosition, flagCurvature: FLAG_CURVATURE, srcY, dstY };
                        const arcD = { src_ip: p.src_ip, dst_ip: p.dst_ip, binned: d.binned, binCenter: d.binCenter, timestamp: d.timestamp, flagType: d.flagType, flags: d.flags };
                        const arcPath = arcPathGenerator(arcD, arcOpts);
                        if (arcPath) {
                            const color = getFlagColor(d);
                            // Draw full arc
                            const arcEl = mainGroup.append('path').attr('class', 'hover-arc').attr('d', arcPath)
                                .style('stroke', color).style('stroke-width', '2px')
                                .style('stroke-opacity', 0.8).style('fill', 'none')
                                .style('pointer-events', 'none');
                            // Arrowhead: fixed 12px line at end with marker-end
                            const pathNode = arcEl.node();
                            const totalLen = pathNode.getTotalLength();
                            const ARROW_BACK = 12;
                            if (totalLen > ARROW_BACK + 5) {
                                const sp = pathNode.getPointAtLength(totalLen - ARROW_BACK);
                                const ep = pathNode.getPointAtLength(totalLen);
                                const colorKey = color.replace(/[^a-zA-Z0-9]/g, '');
                                const markerId = `arc-arrow-${colorKey}`;
                                const svgEl = d3.select(mainGroup.node().ownerSVGElement);
                                let defs = svgEl.select('defs');
                                if (defs.empty()) defs = svgEl.insert('defs', ':first-child');
                                if (defs.select(`#${markerId}`).empty()) {
                                    defs.append('marker')
                                        .attr('id', markerId)
                                        .attr('viewBox', '0 0 10 10')
                                        .attr('refX', 10).attr('refY', 5)
                                        .attr('markerWidth', 8).attr('markerHeight', 8)
                                        .attr('markerUnits', 'userSpaceOnUse')
                                        .attr('orient', 'auto')
                                      .append('path')
                                        .attr('d', 'M0,0 L10,5 L0,10 Z')
                                        .attr('fill', color);
                                }
                                mainGroup.append('path').attr('class', 'hover-arc')
                                    .attr('d', `M${sp.x},${sp.y} L${ep.x},${ep.y}`)
                                    .style('stroke', color).style('stroke-width', '2px')
                                    .style('stroke-opacity', 0.8).style('fill', 'none')
                                    .style('pointer-events', 'none')
                                    .attr('marker-end', `url(#${markerId})`);
                            }
                        }
                    });
                    tooltip.style('display', 'block').html(createTooltipHTML(d));
                    // Highlight source/destination IP labels and rows
                    if (onCircleHighlight) {
                        const dstIps = new Set(pairsToArc.map(p => p.dst_ip));
                        onCircleHighlight(d.src_ip, dstIps);
                    }
                })
                .on('mousemove', e => { tooltip.style('left', `${e.pageX + 40}px`).style('top', `${e.pageY - 40}px`); })
                .on('mouseout', e => {
                    const dot = d3.select(e.currentTarget);
                    dot.classed('highlighted', false).style('stroke', null).style('stroke-width', null);
                    const baseR = +dot.attr('data-orig-r') || RADIUS_MIN; dot.attr('r', baseR);
                    mainGroup.selectAll('.hover-arc').remove(); tooltip.style('display', 'none');
                    if (onCircleClearHighlight) onCircleClearHighlight();
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

    // Return processed data so callers can access final positions (with flag separation)
    return processed;
}
