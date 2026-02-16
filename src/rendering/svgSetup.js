// src/rendering/svgSetup.js
// SVG container and layer creation for TimeArcs visualization

/**
 * Create the main SVG structure with layers for rendering.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.d3 - D3 library reference
 * @param {string} options.containerId - Container element ID (default: '#chart')
 * @param {number} options.width - Chart width
 * @param {number} options.height - Chart height
 * @param {Object} options.margin - { top, right, bottom, left }
 * @param {number} [options.dotRadius=40] - Dot radius for clip path sizing
 * @returns {Object} { svgContainer, svg, mainGroup, fullDomainLayer, dynamicLayer }
 */
export function createSVGStructure(options) {
    const {
        d3,
        containerId = '#chart',
        width,
        height,
        margin,
        dotRadius = 40
    } = options;

    // Create outer SVG container
    const svgContainer = d3.select(containerId).append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom);

    // Create main group with margin transform
    const svg = svgContainer.append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);

    // Create clip path for content bounds
    svg.append('defs').append('clipPath')
        .attr('id', 'clip')
        .append('rect')
        .attr('x', 0)
        .attr('y', -dotRadius)
        .attr('width', width + dotRadius)
        .attr('height', height + (2 * dotRadius));

    // Create clipped main group for marks
    const mainGroup = svg.append('g')
        .attr('clip-path', 'url(#clip)');

    // Create two layers for rendering optimization:
    // - fullDomainLayer: Pre-rendered full domain view (cached)
    // - dynamicLayer: Active rendering during zoom/pan
    const fullDomainLayer = mainGroup.append('g')
        .attr('class', 'dots-full-domain');
    const dynamicLayer = mainGroup.append('g')
        .attr('class', 'dots-dynamic');

    return {
        svgContainer,
        svg,
        mainGroup,
        fullDomainLayer,
        dynamicLayer
    };
}

/**
 * Create the bottom overlay with axis and duration label.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.d3 - D3 library reference
 * @param {string} options.overlaySelector - Selector for overlay SVG (default: '#chart-bottom-overlay-svg')
 * @param {number} options.width - Chart width
 * @param {number} options.chartMarginLeft - Left margin
 * @param {number} options.chartMarginRight - Right margin
 * @param {number} options.overlayHeight - Overlay height
 * @param {Function} options.xScale - X scale for axis
 * @param {Function} options.tickFormatter - Tick formatter function
 * @returns {Object} { bottomOverlaySvg, bottomOverlayRoot, bottomOverlayAxisGroup, bottomOverlayDurationLabel, bottomOverlayWidth }
 */
export function createBottomOverlay(options) {
    const {
        d3,
        overlaySelector = '#chart-bottom-overlay-svg',
        width,
        chartMarginLeft,
        chartMarginRight,
        overlayHeight,
        xScale,
        tickFormatter
    } = options;

    const bottomOverlayWidth = Math.max(0, width + chartMarginLeft + chartMarginRight);
    const bottomOverlaySvg = d3.select(overlaySelector);
    bottomOverlaySvg.attr('width', bottomOverlayWidth).attr('height', overlayHeight);

    // Get or create root group
    let bottomOverlayRoot = bottomOverlaySvg.select('g.overlay-root');
    if (bottomOverlayRoot.empty()) {
        bottomOverlayRoot = bottomOverlaySvg.append('g').attr('class', 'overlay-root');
    }
    bottomOverlayRoot.attr('transform', `translate(${chartMarginLeft},0)`);

    // Position axis near bottom
    const axisY = Math.max(20, overlayHeight - 20);

    // Remove existing axis and create new one
    bottomOverlaySvg.select('.main-bottom-axis').remove();
    const bottomOverlayAxisGroup = bottomOverlayRoot.append('g')
        .attr('class', 'x-axis axis main-bottom-axis')
        .attr('transform', `translate(0,${axisY})`)
        .call(d3.axisBottom(xScale).tickFormat(tickFormatter));

    // Remove existing label and create new one
    bottomOverlaySvg.select('.overlay-duration-label').remove();
    const bottomOverlayDurationLabel = bottomOverlayRoot.append('text')
        .attr('class', 'overlay-duration-label')
        .attr('x', width / 2)
        .attr('y', axisY - 12)
        .attr('text-anchor', 'middle')
        .style('font-size', '36px')
        .style('font-weight', '600')
        .style('fill', '#000')
        .style('opacity', 0.12)
        .text('');

    return {
        bottomOverlaySvg,
        bottomOverlayRoot,
        bottomOverlayAxisGroup,
        bottomOverlayDurationLabel,
        bottomOverlayWidth,
        axisY
    };
}

/**
 * Render IP row labels on the left gutter with background highlight rectangles.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.d3 - D3 library reference
 * @param {Object} options.svg - D3 selection of main SVG group
 * @param {Array<string>} options.yDomain - Ordered list of IPs
 * @param {Map<string, number>} options.ipPositions - Map of IP -> y position
 * @param {number} [options.chartWidth] - Chart width for row highlight rectangles
 * @param {number} [options.rowHeight] - Row height for highlight rectangles (default 20)
 * @param {Function} options.onHighlight - Highlight callback (ip) => void
 * @param {Function} options.onClearHighlight - Clear highlight callback () => void
 * @returns {Object} D3 selection of node groups
 */
export function renderIPRowLabels(options) {
    const {
        d3,
        svg,
        yDomain,
        ipPositions,
        chartWidth = 2000,
        rowHeight = 20,
        onHighlight,
        onClearHighlight,
        ipPairCounts = null,
        collapsedIPs = null,
        onToggleCollapse = null,
        ipPairOrderByRow = null,
        ipRowHeights = null
    } = options;

    // Create row highlight rectangles (behind everything)
    // Insert at the beginning so they're behind other elements
    const highlightGroup = svg.insert('g', ':first-child')
        .attr('class', 'row-highlights');

    highlightGroup.selectAll('.row-highlight')
        .data(yDomain)
        .enter()
        .append('rect')
        .attr('class', 'row-highlight')
        .attr('x', 0)
        .attr('y', d => (ipPositions.get(d) || 0) - rowHeight / 2)
        .attr('width', chartWidth)
        .attr('height', d => (ipRowHeights && ipRowHeights.get(d)) || rowHeight)
        .style('fill', '#4dabf7')
        .style('opacity', 0);

    const nodes = svg.selectAll('.node')
        .data(yDomain)
        .enter()
        .append('g')
        .attr('class', 'node')
        .attr('transform', d => `translate(0,${ipPositions.get(d)})`);

    nodes.append('text')
        .attr('class', 'node-label')
        .attr('x', -10)
        .attr('dy', '.35em')
        .attr('text-anchor', 'end')
        .text(d => d)
        .on('mouseover', (e, d) => {
            if (onHighlight) {
                try {
                    // When expanded with multiple pairs, highlight pair at index 0
                    const pairCount = ipPairCounts ? (ipPairCounts.get(d) || 1) : 1;
                    const isExpanded = pairCount > 1 && !(collapsedIPs && collapsedIPs.has(d));
                    if (isExpanded && ipPairOrderByRow) {
                        const baseY = ipPositions.get(d);
                        const pairInfo = ipPairOrderByRow.get(baseY);
                        if (pairInfo) {
                            for (const [pairKey, idx] of pairInfo.order) {
                                if (idx === 0) {
                                    const parts = pairKey.split('<->');
                                    const partnerIp = parts[0] === d ? parts[1] : parts[0];
                                    onHighlight({ ip: d, pairIp: partnerIp });
                                    return;
                                }
                            }
                        }
                    }
                    onHighlight({ ip: d });
                } catch (_) { /* ignore */ }
            }
        })
        .on('mouseout', () => {
            if (onClearHighlight) {
                try { onClearHighlight(); } catch (_) { /* ignore */ }
            }
        });

    // Add collapse/expand triangle buttons for IPs with >1 pair
    if (onToggleCollapse && ipPairCounts) {
        nodes.each(function(ip) {
            const pairCount = ipPairCounts.get(ip) || 1;
            if (pairCount <= 1) return;

            const node = d3.select(this);
            const isCollapsed = collapsedIPs && collapsedIPs.has(ip);
            const labelNode = node.select('.node-label').node();

            // Position triangle to the left of the label text using actual text width
            // Extra spacing (18px) accounts for label expansion when highlighted (bold + larger font)
            let toggleX = -24;
            try {
                const bbox = labelNode.getBBox();
                // bbox.x is negative (text-anchor: end), so left edge = bbox.x
                toggleX = bbox.x - 18;
            } catch (_) {}

            const toggle = node.append('g')
                .attr('class', 'collapse-toggle')
                .attr('transform', `translate(${toggleX}, 0)`)
                .style('cursor', 'pointer');

            // Circle background
            toggle.append('circle')
                .attr('r', 7)
                .attr('fill', isCollapsed ? '#6c757d' : '#28a745')
                .attr('stroke', '#fff')
                .attr('stroke-width', 2)
                .style('transition', 'fill 0.2s ease');

            // Chevron icon: right for collapsed, down for expanded
            toggle.append('path')
                .attr('class', 'collapse-icon')
                .attr('d', isCollapsed
                    ? 'M -2 -3 L 2 0 L -2 3'   // chevron right
                    : 'M -3 -2 L 0 2 L 3 -2')   // chevron down
                .attr('fill', 'none')
                .attr('stroke', '#fff')
                .attr('stroke-width', 2)
                .attr('stroke-linecap', 'round')
                .attr('stroke-linejoin', 'round');

            // Stop mousedown from triggering the drag-reorder behavior
            toggle
                .on('mousedown', (event) => {
                    event.stopPropagation();
                })
                .on('click', (event) => {
                    event.stopPropagation();
                    onToggleCollapse(ip);
                })
                .on('mouseenter', function() {
                    const ip = d3.select(this.parentNode).datum();
                    const collapsed = collapsedIPs && collapsedIPs.has(ip);
                    d3.select(this).select('circle')
                        .attr('fill', collapsed ? '#5a6268' : '#218838');
                })
                .on('mouseleave', function() {
                    const ip = d3.select(this.parentNode).datum();
                    const collapsed = collapsedIPs && collapsedIPs.has(ip);
                    d3.select(this).select('circle')
                        .attr('fill', collapsed ? '#6c757d' : '#28a745');
                });
        });
    }

    // Add sub-row hover targets and highlight rects for expanded IPs
    if (ipPairOrderByRow && ipRowHeights && ipPairCounts) {
        const SUB_ROW_GAP = 2;

        // Sub-row highlight rects (behind everything in highlightGroup).
        // They double as hover targets: pointer-events: all so they catch
        // mouse events in empty space, but data circles on top get events first.
        yDomain.forEach(ip => {
            const pairCount = ipPairCounts.get(ip) || 1;
            if (pairCount <= 1) return;
            if (collapsedIPs && collapsedIPs.has(ip)) return;

            const baseY = ipPositions.get(ip);
            if (baseY === undefined) return;
            const pairInfo = ipPairOrderByRow.get(baseY);
            if (!pairInfo || pairInfo.count <= 1) return;

            const rh = ipRowHeights.get(ip) || rowHeight;
            const availableHeight = Math.max(20, rh - 6);
            const totalGaps = Math.max(0, pairInfo.count - 1) * SUB_ROW_GAP;
            const subRowHeight = Math.max(4, (availableHeight - totalGaps) / pairInfo.count);

            for (const [pairKey, pairIndex] of pairInfo.order) {
                const parts = pairKey.split('<->');
                const partnerIp = parts[0] === ip ? parts[1] : parts[0];
                const centerY = baseY + pairIndex * (subRowHeight + SUB_ROW_GAP);

                // Visual highlight rect spans full chart width (no pointer events)
                highlightGroup.append('rect')
                    .attr('class', 'sub-row-highlight')
                    .datum({ ip, partnerIp, pairKey, pairIndex })
                    .attr('x', -150)
                    .attr('y', centerY - subRowHeight / 2)
                    .attr('width', chartWidth + 150)
                    .attr('height', subRowHeight)
                    .style('fill', '#4dabf7')
                    .style('opacity', 0);

                // Index 0 hover is handled by the main IP label;
                // other sub-rows get a narrow hover target limited to the label area
                if (pairIndex > 0) {
                    highlightGroup.append('rect')
                        .attr('class', 'sub-row-hover-target')
                        .datum({ ip, partnerIp, pairKey, pairIndex })
                        .attr('x', -150)
                        .attr('y', centerY - subRowHeight / 2)
                        .attr('width', 150)
                        .attr('height', subRowHeight)
                        .style('fill', 'transparent')
                        .style('pointer-events', 'all')
                        .on('mouseover', function() {
                            if (onHighlight) {
                                try { onHighlight({ ip, pairIp: partnerIp }); } catch (_) {}
                            }
                        })
                        .on('mouseout', function() {
                            if (onClearHighlight) {
                                try { onClearHighlight(); } catch (_) {}
                            }
                        });
                }
            }
        });
    }

    return nodes;
}

/**
 * Resize the bottom overlay to match chart width.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.d3 - D3 library reference
 * @param {string} options.overlaySelector - Selector for overlay SVG
 * @param {number} options.width - Chart width
 * @param {number} options.chartMarginLeft - Left margin
 * @param {number} options.chartMarginRight - Right margin
 * @param {number} options.overlayHeight - Overlay height
 * @param {Object} options.bottomOverlayRoot - Root group selection
 * @param {Object} options.bottomOverlayAxisGroup - Axis group selection
 * @param {Function} options.xScale - Current x scale
 * @param {Function} options.tickFormatter - Tick formatter
 */
export function resizeBottomOverlay(options) {
    const {
        d3,
        overlaySelector = '#chart-bottom-overlay-svg',
        width,
        chartMarginLeft,
        chartMarginRight,
        overlayHeight,
        bottomOverlayRoot,
        bottomOverlayAxisGroup,
        xScale,
        tickFormatter
    } = options;

    const bottomOverlayWidth = Math.max(0, width + chartMarginLeft + chartMarginRight);

    d3.select(overlaySelector)
        .attr('width', bottomOverlayWidth)
        .attr('height', overlayHeight);

    if (bottomOverlayRoot) {
        bottomOverlayRoot.attr('transform', `translate(${chartMarginLeft},0)`);
    }

    if (bottomOverlayAxisGroup && xScale) {
        bottomOverlayAxisGroup.call(d3.axisBottom(xScale).tickFormat(tickFormatter));
    }
}
