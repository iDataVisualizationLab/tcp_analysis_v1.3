// src/rendering/bars.js
// Stacked bar rendering for packet visualization

import { classifyFlags } from '../tcp/flags.js';
import { computeBarWidthPx } from '../data/binning.js';

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
        formatBytes,
        formatTimestamp,
        d3
    } = options;

    if (!layer) return;

    // Clear circles in this layer
    try { layer.selectAll('.direction-dot').remove(); } catch {}

    // Build stacks per (timeBin, yPos)
    const stacks = new Map();
    const items = (binned || []).filter(d => d && d.binned);
    const globalFlagTotals = new Map();

    for (const d of items) {
        const ft = d.flagType || classifyFlags(d.flags);
        const c = Math.max(1, d.count || 1);
        globalFlagTotals.set(ft, (globalFlagTotals.get(ft) || 0) + c);
    }

    for (const d of items) {
        const t = Number.isFinite(d.binCenter) ? Math.floor(d.binCenter) :
            (Number.isFinite(d.binTimestamp) ? Math.floor(d.binTimestamp) : Math.floor(d.timestamp));
        const key = `${t}|${d.yPos}`;
        let s = stacks.get(key);
        if (!s) {
            s = { center: t, yPos: d.yPos, byFlag: new Map(), total: 0 };
            stacks.set(key, s);
        }
        const ft = d.flagType || classifyFlags(d.flags);
        const prev = s.byFlag.get(ft) || { count: 0, packets: [] };
        prev.count += Math.max(1, d.count || 1);
        if (Array.isArray(d.originalPackets)) {
            prev.packets = prev.packets.concat(d.originalPackets);
        }
        s.byFlag.set(ft, prev);
        s.total += Math.max(1, d.count || 1);
    }

    const data = Array.from(stacks.values());
    const barWidth = computeBarWidthPx(items, xScale);

    // Find maximum stack total to ensure tallest stack fits within MAX_BAR_H
    let maxStackTotal = 1;
    for (const s of data) {
        if (s.total > maxStackTotal) maxStackTotal = s.total;
    }

    // Ensure max height leaves small gap between rows (ROW_GAP - 4 pixels)
    const MAX_BAR_H = Math.max(6, Math.min(ROW_GAP - 4, 24));
    const hScale = d3.scaleLinear()
        .domain([0, maxStackTotal])
        .range([0, MAX_BAR_H]);

    const toSegments = (s) => {
        const parts = Array.from(s.byFlag.entries()).map(([flag, info]) => ({
            flagType: flag,
            count: info.count,
            packets: info.packets
        }));
        parts.sort((a, b) => {
            const ga = globalFlagTotals.get(a.flagType) || 0;
            const gb = globalFlagTotals.get(b.flagType) || 0;
            if (gb !== ga) return gb - ga;
            return b.count - a.count;
        });
        let acc = 0;
        return parts.map(p => {
            const h = hScale(Math.max(1, p.count));
            const yTop = s.yPos - acc - h;
            acc += h;
            return {
                x: xScale(Math.floor(s.center)) - barWidth / 2,
                y: yTop,
                w: barWidth,
                h,
                datum: {
                    binned: true,
                    count: p.count,
                    flagType: p.flagType,
                    yPos: s.yPos,
                    binCenter: s.center,
                    originalPackets: p.packets || []
                }
            };
        });
    };

    // Stack groups
    const stackJoin = layer.selectAll('.bin-stack').data(data, d => `${Math.floor(d.center)}_${d.yPos}`);
    const stackEnter = stackJoin.enter().append('g').attr('class', 'bin-stack');
    const stackMerge = stackEnter.merge(stackJoin)
        .attr('data-anchor-x', d => xScale(Math.floor(d.center)))
        .attr('data-anchor-y', d => d.yPos)
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
            .data(segs, d => `${Math.floor(d.datum.binCenter || d.datum.timestamp || 0)}_${d.datum.yPos}_${d.datum.flagType}`);

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
                const tooltipHTML = `<b>${ft}</b><br>Count: ${count}<br>Center: ${cUTC}<br>Bytes: ${bytes}`;
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
