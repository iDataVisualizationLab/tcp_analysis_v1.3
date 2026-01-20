// src/rendering/rows.js
// IP row lines and labels

/**
 * Compute IP activity spans.
 * @param {Object[]} links
 * @returns {Map<string, {min: number, max: number}>}
 */
export function computeIpSpans(links) {
  const spans = new Map();
  for (const l of links) {
    for (const ip of [l.source, l.target]) {
      const span = spans.get(ip) || { min: l.minute, max: l.minute };
      if (l.minute < span.min) span.min = l.minute;
      if (l.minute > span.max) span.max = l.minute;
      spans.set(ip, span);
    }
  }
  return spans;
}

/**
 * Create span data array for rendering.
 * @param {string[]} ips
 * @param {Map} ipSpans
 * @returns {Array<{ip: string, span: {min, max}|undefined}>}
 */
export function createSpanData(ips, ipSpans) {
  return ips.map(ip => ({ ip, span: ipSpans.get(ip) }));
}

/**
 * Render row lines.
 * @param {d3.Selection} container
 * @param {Array} spanData
 * @param {number} marginLeft
 * @param {Function} yScale - Y scale function
 * @returns {d3.Selection}
 */
export function renderRowLines(container, spanData, marginLeft, yScale) {
  return container.selectAll('line')
    .data(spanData)
    .join('line')
    .attr('class', 'row-line')
    .attr('x1', marginLeft)
    .attr('x2', marginLeft)
    .attr('y1', d => yScale(d.ip))
    .attr('y2', d => yScale(d.ip))
    .style('opacity', 0);
}

/**
 * Render IP labels.
 * @param {d3.Selection} container
 * @param {string[]} ips
 * @param {Map} ipToNode
 * @param {number} marginLeft
 * @param {Function} yScale - Y scale function for fallback
 * @returns {d3.Selection}
 */
export function renderIpLabels(container, ips, ipToNode, marginLeft, yScale) {
  return container.selectAll('text')
    .data(ips)
    .join('text')
    .attr('class', 'ip-label')
    .attr('data-ip', d => d)
    .attr('x', d => {
      const node = ipToNode.get(d);
      return node && node.xConnected !== undefined ? node.xConnected : marginLeft;
    })
    .attr('y', d => {
      const node = ipToNode.get(d);
      return node && node.y !== undefined ? node.y : yScale(d);
    })
    .attr('text-anchor', 'end')
    .attr('dominant-baseline', 'middle')
    .style('cursor', 'pointer')
    .text(d => d);
}

/**
 * Create label hover handler.
 * @param {Object} config
 * @returns {Function}
 */
export function createLabelHoverHandler(config) {
  const { 
    linksWithNodes, arcPaths, svg, widthScale, 
    showTooltip, tooltip 
  } = config;
  
  return function(event, hoveredIp) {
    // Find all arcs connected to this IP (as source or target)
    const connectedArcs = linksWithNodes.filter(l => 
      l.sourceNode.name === hoveredIp || l.targetNode.name === hoveredIp
    );
    const connectedIps = new Set();
    connectedArcs.forEach(l => {
      connectedIps.add(l.sourceNode.name);
      connectedIps.add(l.targetNode.name);
    });

    // Highlight connected arcs: full opacity for connected, dim others
    arcPaths.style('stroke-opacity', d => {
      const isConnected = d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp;
      return isConnected ? 1 : 0.2;
    })
    .attr('stroke-width', d => {
      const isConnected = d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp;
      if (isConnected) {
        const baseW = widthScale(Math.max(1, d.count));
        return Math.max(3, baseW < 2 ? baseW * 2.5 : baseW * 1.3);
      }
      return widthScale(Math.max(1, d.count));
    });

    // Highlight row lines for connected IPs
    svg.selectAll('.row-line')
      .attr('stroke-opacity', s => s && s.ip && connectedIps.has(s.ip) ? 0.8 : 0.1)
      .attr('stroke-width', s => s && s.ip && connectedIps.has(s.ip) ? 1 : 0.4);

    // Highlight IP labels for connected IPs
    const hoveredLabel = d3.select(this);
    const hoveredColor = hoveredLabel.style('fill') || '#343a40';
    svg.selectAll('.ip-label')
      .attr('font-weight', s => connectedIps.has(s) ? 'bold' : null)
      .style('font-size', s => connectedIps.has(s) ? '14px' : null)
      .style('fill', s => {
        if (s === hoveredIp) return hoveredColor;
        return connectedIps.has(s) ? '#007bff' : '#343a40';
      });

    // Show tooltip with IP information
    const arcCount = connectedArcs.length;
    const uniqueConnections = new Set();
    connectedArcs.forEach(l => {
      if (l.sourceNode.name === hoveredIp) uniqueConnections.add(l.targetNode.name);
      if (l.targetNode.name === hoveredIp) uniqueConnections.add(l.sourceNode.name);
    });
    const content = `IP: ${hoveredIp}<br>` +
      `Connected arcs: ${arcCount}<br>` +
      `Unique connections: ${uniqueConnections.size}`;
    showTooltip(tooltip, event, content);
  };
}

/**
 * Create label mousemove handler.
 * @param {HTMLElement} tooltip
 * @returns {Function}
 */
export function createLabelMoveHandler(tooltip) {
  return function(event) {
    if (tooltip && tooltip.style.display !== 'none') {
      const pad = 10;
      tooltip.style.left = (event.clientX + pad) + 'px';
      tooltip.style.top = (event.clientY + pad) + 'px';
    }
  };
}

/**
 * Create label mouseout handler.
 * @param {Object} config
 * @returns {Function}
 */
export function createLabelLeaveHandler(config) {
  const { arcPaths, svg, widthScale, hideTooltip, tooltip } = config;
  
  return function() {
    hideTooltip(tooltip);
    // Restore default state
    arcPaths.style('stroke-opacity', 0.6)
            .attr('stroke-width', d => widthScale(Math.max(1, d.count)));
    svg.selectAll('.row-line').attr('stroke-opacity', 1).attr('stroke-width', 0.4);
    svg.selectAll('.ip-label')
      .attr('font-weight', null)
      .style('font-size', null)
      .style('fill', '#343a40');
  };
}

/**
 * Attach hover handlers to labels.
 * @param {d3.Selection} labels
 * @param {Function} hoverHandler
 * @param {Function} moveHandler
 * @param {Function} leaveHandler
 */
export function attachLabelHoverHandlers(labels, hoverHandler, moveHandler, leaveHandler) {
  labels
    .on('mouseover', hoverHandler)
    .on('mousemove', moveHandler)
    .on('mouseout', leaveHandler);
}

/**
 * Update row lines for animation.
 * @param {d3.Selection} lines
 * @param {Function} xScale
 * @param {Function} yScale
 * @param {number} duration
 * @returns {d3.Transition}
 */
export function animateRowLines(lines, xScale, yScale, duration) {
  return lines
    .transition()
    .duration(duration)
    .attr('x1', d => d.span ? xScale(d.span.min) : 0)
    .attr('x2', d => d.span ? xScale(d.span.max) : 0)
    .attr('y1', d => yScale(d.ip))
    .attr('y2', d => yScale(d.ip))
    .style('opacity', 1);
}

/**
 * Update labels for animation.
 * @param {d3.Selection} labels
 * @param {Function} yScale
 * @param {Map} ipToNode
 * @param {number} duration
 * @returns {d3.Transition}
 */
export function animateLabels(labels, yScale, ipToNode, duration) {
  return labels
    .transition()
    .duration(duration)
    .attr('y', d => yScale(d))
    .attr('x', d => {
      const node = ipToNode.get(d);
      return node && node.xConnected !== undefined ? node.xConnected : 0;
    });
}
