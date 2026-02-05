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
        onToggleCollapse = null
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
        .attr('height', rowHeight)
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
                try { onHighlight({ ip: d }); } catch (_) { /* ignore */ }
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
            let toggleX = -24;
            try {
                const bbox = labelNode.getBBox();
                // bbox.x is negative (text-anchor: end), so left edge = bbox.x
                toggleX = bbox.x - 10;
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

            // Pair count badge
            toggle.append('text')
                .attr('class', 'pair-count-badge')
                .attr('x', -12)
                .attr('dy', '.35em')
                .attr('text-anchor', 'end')
                .style('font-size', '9px')
                .style('fill', '#999')
                .text(pairCount);

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
