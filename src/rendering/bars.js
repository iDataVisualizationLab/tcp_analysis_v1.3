// src/rendering/bars.js
// Stacked bar rendering for packet visualization

import { classifyFlags } from '../tcp/flags.js';
import { computeBarWidthPx } from '../data/binning.js';

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
 * Render stacked bars for binned items into a layer.
 * @param {Object} layer - D3 selection (g element)
 * @param {Array} binned - Binned packet data
 * @param {Object} options - Rendering options
 */
export function renderBars(layer, binned, options) {
    const {
        xScale,
        flagColors,
        globalMaxBinCount,
        ROW_GAP,
        ipRowHeights,
        ipPairCounts,
        ipPositions,
        formatBytes,
        formatTimestamp,
        d3
    } = options;

    if (!layer) return;

    // Clear circles in this layer
    try { layer.selectAll('.direction-dot').remove(); } catch {}

    // Build stacks per (timeBin, yPos, ipPair)
    const stacks = new Map();
    const items = (binned || []).filter(d => d && d.binned);
    const globalFlagTotals = new Map();

    for (const d of items) {
        const ft = d.flagType || classifyFlags(d.flags);
        const c = Math.max(1, d.count || 1);
        globalFlagTotals.set(ft, (globalFlagTotals.get(ft) || 0) + c);
    }

    // Collect unique IP pairs per row (yPos) with earliest timestamp for ordering
    const ipPairsByRow = new Map(); // yPos -> Map(ipPairKey -> earliestTimestamp)
    for (const d of items) {
        const ipPairKey = makeIpPairKey(d.src_ip, d.dst_ip);
        if (!ipPairsByRow.has(d.yPos)) {
            ipPairsByRow.set(d.yPos, new Map());
        }
        const pairMap = ipPairsByRow.get(d.yPos);
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

    // Group by position AND IP pair for stacking, but don't combine same flag types
    for (let i = 0; i < items.length; i++) {
        const d = items[i];
        const t = Number.isFinite(d.binCenter) ? Math.floor(d.binCenter) :
            (Number.isFinite(d.binTimestamp) ? Math.floor(d.binTimestamp) : Math.floor(d.timestamp));
        const ft = d.flagType || classifyFlags(d.flags);
        const count = Math.max(1, d.count || 1);
        const ipPairKey = makeIpPairKey(d.src_ip, d.dst_ip);
        // Group by position AND IP pair for stacking different flag types
        const key = `${t}|${d.yPos}|${ipPairKey}`;
        let s = stacks.get(key);
        if (!s) {
            const pairInfo = ipPairOrderByRow.get(d.yPos) || { order: new Map(), count: 1 };
            const pairIndex = pairInfo.order.get(ipPairKey) || 0;
            const pairCount = pairInfo.count;
            s = { center: t, yPos: d.yPos, srcIp: d.src_ip, ipPairKey, pairIndex, pairCount, byFlag: new Map(), total: 0 };
            stacks.set(key, s);
        }
        // Use index in byFlag key to prevent combining same flag types
        const flagKey = `${ft}_${i}`;
        s.byFlag.set(flagKey, { count, packets: Array.isArray(d.originalPackets) ? d.originalPackets : [], flagType: ft });
        s.total += count;
    }

    const data = Array.from(stacks.values());
    const barWidth = computeBarWidthPx(items, xScale);

    // Find maximum stack total to ensure tallest stack fits within max bar height
    let maxStackTotal = 1;
    for (const s of data) {
        if (s.total > maxStackTotal) maxStackTotal = s.total;
    }

    // Layout constants
    const SUB_ROW_GAP = 2; // Gap between sub-rows
    const DEFAULT_ROW_HEIGHT = ROW_GAP || 30;

    const toSegments = (s) => {
        const parts = Array.from(s.byFlag.entries()).map(([flagKey, info]) => ({
            flagKey,
            flagType: info.flagType || flagKey.split('_')[0],
            count: info.count,
            packets: info.packets
        }));
        parts.sort((a, b) => {
            const ga = globalFlagTotals.get(a.flagType) || 0;
            const gb = globalFlagTotals.get(b.flagType) || 0;
            if (gb !== ga) return gb - ga;
            return b.count - a.count;
        });

        // Get this IP's row height (dynamic per-IP)
        const rowHeight = (ipRowHeights && ipRowHeights.get(s.srcIp)) || DEFAULT_ROW_HEIGHT;
        const availableHeight = Math.max(20, rowHeight - 6);

        // Calculate sub-row height based on how many pairs share this row
        const pairCount = s.pairCount || 1;
        const totalGaps = Math.max(0, pairCount - 1) * SUB_ROW_GAP;
        const subRowHeight = Math.max(4, (availableHeight - totalGaps) / pairCount);

        // Scale bar heights to fit within sub-row
        const hScale = d3.scaleLinear()
            .domain([0, maxStackTotal])
            .range([0, subRowHeight]);

        // First pair (pairIndex 0) aligns with baseline (yPos) where label is
        // Subsequent pairs grow DOWNWARD from there
        // Offset by half sub-row height so bar center aligns with label
        const pairTopY = s.yPos - subRowHeight / 2 + s.pairIndex * (subRowHeight + SUB_ROW_GAP);

        let acc = 0;
        return parts.map((p, idx) => {
            const h = hScale(Math.max(1, p.count));
            // Bars stack downward from the top of their sub-row
            const yTop = pairTopY + acc;
            acc += h;
            return {
                x: xScale(Math.floor(s.center)) - barWidth / 2,
                y: yTop,
                w: barWidth,
                h,
                segIdx: idx,
                ipPairKey: s.ipPairKey,
                subRowCenter: pairTopY + subRowHeight / 2,
                datum: {
                    binned: true,
                    count: p.count,
                    flagType: p.flagType,
                    yPos: s.yPos,
                    binCenter: s.center,
                    originalPackets: p.packets || [],
                    ipPairKey: s.ipPairKey
                }
            };
        });
    };

    // Stack groups (grouped by position AND IP pair, different flags stack vertically)
    const stackJoin = layer.selectAll('.bin-stack').data(data, d => `${Math.floor(d.center)}_${d.yPos}_${d.ipPairKey}`);
    const stackEnter = stackJoin.enter().append('g').attr('class', 'bin-stack');
    const stackMerge = stackEnter.merge(stackJoin)
        .attr('data-anchor-x', d => xScale(Math.floor(d.center)))
        .attr('data-anchor-y', d => d.yPos) // Use baseline as anchor
        .attr('transform', null);

    // Add hover handlers for scale effect
    stackMerge
        .on('mouseenter', function(event, d) {
            const g = d3.select(this);
            const ax = +g.attr('data-anchor-x') || xScale(Math.floor(d.center));
            const ay = +g.attr('data-anchor-y') || d.yPos;
            const sx = 1.4, sy = 1.8;
            g.raise().attr('transform', `translate(${ax},${ay}) scale(${sx},${sy}) translate(${-ax},${-ay})`);
        })
        .on('mouseleave', function() {
            d3.select(this).attr('transform', null);
            d3.select('#tooltip').style('display', 'none');
        });

    // Segments within each stack
    stackMerge.each(function(s) {
        const segs = toSegments(s);
        const segJoin = d3.select(this).selectAll('.bin-bar-segment')
            .data(segs, d => `${Math.floor(d.datum.binCenter || d.datum.timestamp || 0)}_${d.datum.yPos}_${d.ipPairKey}_${d.segIdx}`);

        segJoin.enter().append('rect')
            .attr('class', 'bin-bar-segment')
            .attr('x', d => d.x)
            .attr('y', d => d.y)
            .attr('width', d => d.w)
            .attr('height', d => d.h)
            .style('fill', d => flagColors[d.datum.flagType] || flagColors.OTHER)
            .style('opacity', 0.8)
            .style('stroke', 'none')
            .style('cursor', 'pointer')
            .on('mousemove', (event, d) => {
                const datum = d.datum || {};
                const center = Math.floor(datum.binCenter || datum.timestamp || 0);
                const { utcTime: cUTC } = formatTimestamp(center);
                const count = datum.count || 0;
                const ft = datum.flagType || 'OTHER';
                const bytes = formatBytes(datum.totalBytes || 0);
                const ipPair = datum.ipPairKey || '';
                const pairLine = ipPair ? `<br>Pair: ${ipPair}` : '';
                const tooltipHTML = `<b>${ft}</b><br>Count: ${count}<br>Center: ${cUTC}<br>Bytes: ${bytes}${pairLine}`;
                d3.select('#tooltip')
                    .style('display', 'block')
                    .html(tooltipHTML)
                    .style('left', `${event.pageX + 40}px`)
                    .style('top', `${event.pageY - 40}px`);
            })
            .on('mouseleave', () => {
                d3.select('#tooltip').style('display', 'none');
            })
            .merge(segJoin)
            .attr('x', d => d.x)
            .attr('y', d => d.y)
            .attr('width', d => d.w)
            .attr('height', d => d.h)
            .style('fill', d => flagColors[d.datum.flagType] || flagColors.OTHER);

        segJoin.exit().remove();
    });

    stackJoin.exit().remove();
}

/**
 * Unified render function - dispatches to bars or circles.
 * @param {Object} layer - D3 selection
 * @param {Array} data - Binned data
 * @param {Object} options - Must include renderMode and renderCircles function
 */
export function renderMarksForLayer(layer, data, options) {
    if (options.renderMode === 'bars') {
        return renderBars(layer, data, options);
    }
    // Call the passed renderCircles function for circle mode
    return options.renderCircles(layer, data, options);
}
