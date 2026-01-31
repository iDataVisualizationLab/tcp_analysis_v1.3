// Legend rendering helpers extracted from sidebar.js and ip_arc_diagram.js
// Provides simple DOM injection for legend panels with a title + items

export function renderInvalidLegend(panelEl, legendItemsHtml, totalText) {
    if (!panelEl) return;
    panelEl.innerHTML = `<div style="font-weight:600; margin-bottom:6px;">${totalText}</div>${legendItemsHtml}`;
}

export function renderClosingLegend(panelEl, legendItemsHtml, totalText) {
    if (!panelEl) return;
    panelEl.innerHTML = `<div style="font-weight:600; margin-bottom:6px;">${totalText}</div>${legendItemsHtml}`;
}

// Flow legend helper functions extracted from sidebar.js
export function getFlowColors(flowColors = {}) {
    return {
        graceful: (flowColors.closing && flowColors.closing.graceful) || '#8e44ad',
        abortive: (flowColors.closing && flowColors.closing.abortive) || '#c0392b'
    };
}

export function getInvalidLabels() {
    return {
        'invalid_ack': 'Invalid ACK',
        'rst_during_handshake': 'RST during handshake',
        'incomplete_no_synack': 'Incomplete (no SYN+ACK)',
        'incomplete_no_ack': 'Incomplete (no ACK)',
        'invalid_synack': 'Invalid SYN+ACK',
        'unknown_invalid': 'Invalid (unspecified)'
    };
}

export function getInvalidReason(flow) {
    if (!flow) return null;
    let r = flow.invalidReason;
    if (!r && (flow.closeType === 'invalid' || flow.state === 'invalid')) r = 'unknown_invalid';
    return r || null;
}

export function getFlowColor(flow, flowColors = {}) {
    const reason = getInvalidReason(flow);
    if (reason) {
        return (flowColors.invalid && flowColors.invalid[reason]) || '#6c757d';
    }
    if (flow && (flow.closeType === 'graceful' || flow.closeType === 'abortive')) {
        const closeColors = getFlowColors(flowColors);
        return closeColors[flow.closeType] || '#6c757d';
    }
    return '#adb5bd'; // neutral grey for unknown/ongoing
}

// Create horizontal flow legend for overview chart
export function createOverviewFlowLegend({ svg, width, height, flowColors = {}, flows = [], hiddenInvalidReasons, hiddenCloseTypes, d3, onToggleReason, onToggleCloseType }) {
    try {
        // Remove existing legend
        svg.select('.overview-flow-legend').remove();

        const invalidLabels = getInvalidLabels();
        const closeColors = getFlowColors(flowColors);
        
        // Calculate counts for each category
        const isInvalid = (f) => f && (f.closeType === 'invalid' || f.state === 'invalid' || !!f.invalidReason);
        const isClosedGraceful = (f) => f && f.closeType === 'graceful';
        const isClosedAbortive = (f) => f && f.closeType === 'abortive';
        const isClosed = (f) => isClosedGraceful(f) || isClosedAbortive(f);
        const isOngoingCandidate = (f) => f && !isInvalid(f) && !isClosed(f);
        const isOpen = (f) => isOngoingCandidate(f) && (f.establishmentComplete === true || f.state === 'established' || f.state === 'data_transfer');

        const invalidFlows = flows.filter(isInvalid);
        const gracefulCount = flows.filter(isClosedGraceful).length;
        const abortiveCount = flows.filter(isClosedAbortive).length;
        const openCount = flows.filter(isOpen).length;

        // Calculate invalid reason counts
        const invalidReasonCounts = new Map();
        const invalidOrder = ['invalid_ack', 'rst_during_handshake', 'incomplete_no_synack', 'incomplete_no_ack', 'invalid_synack', 'unknown_invalid'];
        
        invalidOrder.forEach(reason => invalidReasonCounts.set(reason, 0));
        invalidFlows.forEach(f => {
            let reason = getInvalidReason(f);
            if (!reason) reason = 'unknown_invalid';
            if (invalidReasonCounts.has(reason)) {
                invalidReasonCounts.set(reason, invalidReasonCounts.get(reason) + 1);
            }
        });

        // Build legend items array
        const legendItems = [];
        
        // Add closing types
        if (gracefulCount > 0) {
            legendItems.push({
                type: 'closing',
                key: 'graceful',
                label: 'Graceful closes',
                color: closeColors.graceful,
                count: gracefulCount,
                hidden: hiddenCloseTypes && hiddenCloseTypes.has('graceful')
            });
        }
        if (abortiveCount > 0) {
            legendItems.push({
                type: 'closing',
                key: 'abortive', 
                label: 'Abortive (RST)',
                color: closeColors.abortive,
                count: abortiveCount,
                hidden: hiddenCloseTypes && hiddenCloseTypes.has('abortive')
            });
        }

        // Add ongoing flows
        if (openCount > 0) {
            legendItems.push({
                type: 'ongoing',
                key: 'open',
                label: 'Open flows',
                color: (flowColors.ongoing && flowColors.ongoing.open) || '#6c757d',
                count: openCount,
                hidden: hiddenCloseTypes && hiddenCloseTypes.has('open')
            });
        }

        // Add invalid reasons (only those with counts > 0)
        invalidOrder.forEach(reason => {
            const count = invalidReasonCounts.get(reason) || 0;
            if (count > 0) {
                const color = (flowColors.invalid && flowColors.invalid[reason]) || 
                    d3.color(reason.includes('ack') ? '#27ae60' : (reason.includes('rst') ? '#34495e' : '#bdc3c7')).darker(0.5).formatHex();
                legendItems.push({
                    type: 'invalid',
                    key: reason,
                    label: invalidLabels[reason] || 'Invalid',
                    color: color,
                    count: count,
                    hidden: hiddenInvalidReasons && hiddenInvalidReasons.has(reason)
                });
            }
        });

        if (legendItems.length === 0) return;

        // Create legend group positioned above the chart
        const legendY = -25; // Position above the chart area (negative Y to go above)
        const legendHeight = 20; // Height for legend
        const legendGroup = svg.append('g')
            .attr('class', 'overview-flow-legend')
            .attr('transform', `translate(0, ${legendY})`);

        // Calculate layout
        const itemSpacing = 15;
        const swatchSize = 10;
        const textOffset = 3;
        
        // Measure text and calculate positions
        let currentX = 10;
        const legendData = legendItems.map(item => {
            const textWidth = item.label.length * 6 + item.count.toString().length * 5; // rough estimate
            const itemWidth = swatchSize + textOffset + textWidth + itemSpacing;
            const itemData = { ...item, x: currentX, width: itemWidth };
            currentX += itemWidth;
            return itemData;
        });

        // Create legend items
        const items = legendGroup.selectAll('.legend-item')
            .data(legendData)
            .enter().append('g')
            .attr('class', 'legend-item')
            .attr('transform', d => `translate(${d.x}, 0)`)
            .style('cursor', 'pointer')
            .style('opacity', d => d.hidden ? 0.4 : 1.0);

        // Add color swatches (box shapes for flow types)
        items.append('rect')
            .attr('x', 0)
            .attr('y', 2)
            .attr('width', swatchSize)
            .attr('height', swatchSize)
            .attr('rx', 0)
            .attr('ry', 0)
            .attr('fill', d => d.color)
            .attr('stroke', '#333')
            .attr('stroke-width', 1.5);

        // Add text labels
        items.append('text')
            .attr('x', swatchSize + textOffset)
            .attr('y', 8)
            .attr('dy', '0.35em')
            .style('font-size', '11px')
            .style('font-family', 'sans-serif')
            .style('fill', '#333')
            .text(d => `${d.label} (${d.count})`);

        // Add click handlers
        items.on('click', (event, d) => {
            if (d.type === 'invalid' && typeof onToggleReason === 'function') {
                onToggleReason(d.key);
            } else if ((d.type === 'closing' || d.type === 'ongoing') && typeof onToggleCloseType === 'function') {
                onToggleCloseType(d.key);
            }
        });

        // Add hover effects
        items.on('mouseover', function(event, d) {
            d3.select(this).style('opacity', d.hidden ? 0.6 : 1.0);
        }).on('mouseout', function(event, d) {
            d3.select(this).style('opacity', d.hidden ? 0.4 : 1.0);
        });

    } catch (error) {
        console.warn('Error creating overview flow legend:', error);
    }
}

// Compact flags legend placed next to the size legend (bottom-right)
export function drawFlagLegend({ svg, width, height, flagColors, globalMaxBinCount, RADIUS_MIN, RADIUS_MAX, d3, axisY }) {
    try {
        if (!svg || !width || !height) return;
        svg.select('.flag-legend').remove();

        // Recompute size-legend box to align horizontally
        const maxCount = Math.max(1, globalMaxBinCount);
        const rScale = d3.scaleSqrt().domain([1, maxCount]).range([RADIUS_MIN, RADIUS_MAX]);
        const maxR = Math.max(rScale(maxCount), RADIUS_MIN);
        const padding = 8;
        const labelGap = 32;
        const sizeLegendWidth = maxR * 2 + padding * 2;
        const sizeLegendHeight = 2 * maxR + padding + (padding + labelGap);
        const sizeLegendX = Math.max(0, width - sizeLegendWidth - 12);
    const anchorY = (typeof axisY === 'number') ? axisY : (height - 12);
    const sizeLegendY = Math.max(0, (anchorY - sizeLegendHeight - 8));

        // Build items from flagColors keys; order to follow flag_colors.json
        const allKeys = Object.keys(flagColors || {});
        const preferredOrder = ['SYN', 'SYN+ACK', 'ACK', 'PSH', 'PSH+ACK', 'FIN', 'FIN+ACK', 'RST', 'RST+ACK'];
        let items;
        if (allKeys.length) {
            const std = preferredOrder.filter(k => allKeys.includes(k));
            const extras = allKeys.filter(k => !preferredOrder.includes(k) && k !== 'OTHER').sort((a,b)=>a.localeCompare(b));
            items = [...std, ...extras];
            if (allKeys.includes('OTHER')) items.push('OTHER');
        } else {
            items = ['SYN','SYN+ACK','ACK','PSH+ACK','FIN','FIN+ACK','RST+ACK','RST','OTHER'];
        }

        const sw = 10;       // swatch size
        const rowH = 16;     // row height for readability
        const innerPad = 6;
        const colGap = 16;   // space between columns
        const textLeft = 14; // text x offset from swatch
        const titleH = 14;   // title line height
        const maxRowsPerCol = 6;

        // Split items into columns with up to maxRowsPerCol rows each
        const cols = Math.max(1, Math.ceil(items.length / maxRowsPerCol));
        const columns = Array.from({ length: cols }, (_, ci) => items.slice(ci * maxRowsPerCol, (ci + 1) * maxRowsPerCol));

        // Measure text widths using a temporary DOM element
        const measure = (txt) => {
            try {
                const el = document.createElement('span');
                el.textContent = txt;
                el.style.position = 'absolute';
                el.style.visibility = 'hidden';
                el.style.whiteSpace = 'nowrap';
                el.style.font = '10px sans-serif';
                document.body.appendChild(el);
                const w = el.getBoundingClientRect().width;
                document.body.removeChild(el);
                return Math.ceil(w);
            } catch (_) { return txt.length * 6; }
        };
        const colTextWidths = columns.map(col => (col.length ? Math.max(...col.map(measure)) : 0));
        const colWidths = colTextWidths.map(w => sw + textLeft + w);
        const rows = Math.max(...columns.map(c => c.length), 0);

        const fWidth = innerPad * 2 + (colWidths.length ? colWidths.reduce((a,b)=>a+b,0) : 0) + colGap * Math.max(0, cols - 1);
        const fHeight = innerPad * 2 + titleH + rows * rowH;

        const legendX = Math.max(0, sizeLegendX - 12 - fWidth);
    const legendY = Math.max(0, (anchorY - fHeight - 8));

        const g = svg.append('g')
            .attr('class', 'flag-legend')
            .attr('transform', `translate(${legendX},${legendY})`)
            .style('pointer-events', 'none');

        // Background
        g.append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('rx', 6)
            .attr('ry', 6)
            .attr('width', fWidth)
            .attr('height', fHeight)
            .style('fill', '#fff')
            .style('opacity', 0.85)
            .style('stroke', '#ccc');

        // Title
        g.append('text')
            .attr('x', fWidth / 2)
            .attr('y', 12)
            .attr('text-anchor', 'middle')
            .style('font-size', '11px')
            .style('font-weight', '600')
            .style('fill', '#333')
            .text('Flags');

        const innerTop = titleH + innerPad;
        // Render columns left to right
        let xOffset = innerPad;
        columns.forEach((col, ci) => {
            const colW = colWidths[ci] || (sw + textLeft + 24);
            col.forEach((flag, ri) => {
                const y = innerTop + ri * rowH;
                const color = flagColors[flag] || flagColors.OTHER || '#bdc3c7';
                const x = xOffset;
                
                // Create curved line arc for flag icons (curving to the right)
                const centerX = x + sw / 2;
                const centerY = y - sw / 2 + 6;
                const radius = sw / 2;
                const arcPath = d3.arc()
                    .innerRadius(radius - 1)
                    .outerRadius(radius)
                    .startAngle(0)  // Start from right (0 degrees)
                    .endAngle(Math.PI);  // End at left (180 degrees) - creates right-curving arc
                
                g.append('path')
                    .attr('d', arcPath)
                    .attr('transform', `translate(${centerX}, ${centerY})`)
                    .style('fill', 'none')
                    .style('stroke', color)
                    .style('stroke-width', 2.5)
                    .style('stroke-linecap', 'round');
                    
                g.append('text')
                    .attr('x', x + textLeft)
                    .attr('y', y + 4)
                    .style('font-size', '10px')
                    .style('fill', '#333')
                    .text(flag);
            });
            xOffset += colW + colGap;
        });
    } catch (_) { /* ignore legend draw errors */ }
}

