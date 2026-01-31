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
    .style('font-family', "'Courier New', Courier, monospace")
    .text(d => d);
}

/**
 * Create label hover handler.
 * @param {Object} config
 * @param {Map} config.ipToComponent - Map from IP to component index (optional)
 * @param {Function} config.getComponentExpansionState - Getter for component expansion state (optional)
 * @returns {Function}
 */
export function createLabelHoverHandler(config) {
  const {
    linksWithNodes, arcPaths, svg, widthScale,
    showTooltip, tooltip, ipToComponent, getComponentExpansionState
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
      .style('font-size', s => connectedIps.has(s) ? '12px' : null)
      .style('fill', s => {
        if (s === hoveredIp) return hoveredColor;
        return connectedIps.has(s) ? '#007bff' : '#343a40';
      })
      .style('opacity', s => {
        // Always show labels for connected IPs
        if (connectedIps.has(s)) return 1;

        // For non-connected labels, check component expansion state
        if (getComponentExpansionState && ipToComponent) {
          const componentExpansionState = getComponentExpansionState();
          const compIdx = ipToComponent.get(s);
          if (compIdx !== undefined) {
            const isExpanded = componentExpansionState.get(compIdx) === true;
            if (!isExpanded) return 0; // Keep hidden if component is collapsed
          }
        }

        // Otherwise preserve current opacity (don't change it)
        return null; // null means don't change
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
 * @param {Map} config.ipToComponent - Map from IP to component index (optional)
 * @param {Function} config.getComponentExpansionState - Getter for component expansion state (optional)
 * @returns {Function}
 */
export function createLabelLeaveHandler(config) {
  const { arcPaths, svg, widthScale, hideTooltip, tooltip, ipToComponent, getComponentExpansionState } = config;

  return function() {
    hideTooltip(tooltip);
    // Restore default state
    arcPaths.style('stroke-opacity', 0.6)
            .attr('stroke-width', d => widthScale(Math.max(1, d.count)));
    svg.selectAll('.row-line').attr('stroke-opacity', 1).attr('stroke-width', 0.4);

    const labels = svg.selectAll('.ip-label');
    labels
      .attr('font-weight', null)
      .style('font-size', null)
      .style('fill', '#343a40');

    // Restore opacity based on component expansion state (if available)
    if (getComponentExpansionState && ipToComponent) {
      const componentExpansionState = getComponentExpansionState();
      labels.style('opacity', d => {
        const compIdx = ipToComponent.get(d);
        if (compIdx === undefined) return 1;
        return componentExpansionState.get(compIdx) === true ? 1 : 0;
      });
    }
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
 * Render component expansion toggles.
 * @param {d3.Selection} container - Parent SVG group
 * @param {Array} components - Array of component IP arrays
 * @param {Map} ipToComponent - Map from IP to component index
 * @param {Function} yScale - Y scale function
 * @param {number} marginLeft - Left margin offset
 * @param {Map} componentExpansionState - Map of component index to expansion state
 * @param {Function} onToggle - Callback function when toggle is clicked (receives compIdx)
 * @returns {d3.Selection} Selection of toggle groups
 */
export function renderComponentToggles(container, components, ipToComponent, yScale, marginLeft, componentExpansionState, onToggle, onExport) {
  if (!components || components.length <= 1) {
    // No toggles needed for single component
    return container.selectAll('.component-toggle').data([]).join('g');
  }

  // Create toggle data: one toggle per component
  const toggleData = components.map((comp, idx) => {
    // Find the first (topmost) IP in this component
    const firstIp = comp[0];
    return {
      compIdx: idx,
      ipCount: comp.length,
      ip: firstIp,
      isExpanded: componentExpansionState.get(idx) === true
    };
  });

  const toggleGroups = container.selectAll('.component-toggle')
    .data(toggleData, d => d.compIdx)
    .join('g')
    .attr('class', 'component-toggle')
    .attr('transform', d => `translate(8, ${yScale(d.ip)})`)
    .style('cursor', 'pointer')
    .style('opacity', 0); // Start hidden

  // Circle background
  toggleGroups.selectAll('circle')
    .data(d => [d])
    .join('circle')
    .attr('r', 7)
    .attr('fill', d => d.isExpanded ? '#28a745' : '#6c757d')
    .attr('stroke', '#fff')
    .attr('stroke-width', 2)
    .style('transition', 'fill 0.2s ease');

  // Icon: chevron (right for collapsed, down for expanded)
  toggleGroups.selectAll('path.toggle-icon')
    .data(d => [d])
    .join('path')
    .attr('class', 'toggle-icon')
    .attr('d', d => {
      if (d.isExpanded) {
        // Chevron down
        return 'M -3 -2 L 0 2 L 3 -2';
      } else {
        // Chevron right
        return 'M -2 -3 L 2 0 L -2 3';
      }
    })
    .attr('fill', 'none')
    .attr('stroke', '#fff')
    .attr('stroke-width', 2)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round');

  // Export CSV button (foreignObject for HTML button)
  // if (onExport) {
  //   toggleGroups.selectAll('text.comp-export-btn')
  //     .data(d => [d])
  //     .join('text')
  //     .attr('class', 'comp-export-btn')
  //     .attr('x', 13)
  //     .attr('y', 0)
  //     .attr('dominant-baseline', 'middle')
  //     .attr('text-anchor', 'start')
  //     .style('font-size', '13px')
  //     .style('cursor', 'pointer')
  //     .style('fill', '#6c757d')
  //     .text('\u2913')
  //     .on('click', function(event) {
  //       event.stopPropagation();
  //       onExport(d3.select(this).datum().compIdx);
  //     })
  //     .on('mouseenter', function() {
  //       d3.select(this).style('fill', '#007bff');
  //     })
  //     .on('mouseleave', function() {
  //       d3.select(this).style('fill', '#6c757d');
  //     })
  //     .append('title')
  //     .text(d => `Export component ${d.compIdx} network data as CSV`);
  // }

  // Click handler (for toggle circle area, not export button)
  toggleGroups.on('click', function(event, d) {
    // Don't toggle if click was on the export button
    if (event.target.closest('.comp-export-btn')) return;
    event.stopPropagation();
    if (onToggle) {
      onToggle(d.compIdx);
    }
  });

  // Hover effects
  toggleGroups.on('mouseenter', function(event, d) {
    d3.select(this).select('circle')
      .attr('fill', d.isExpanded ? '#218838' : '#5a6268');
  });

  toggleGroups.on('mouseleave', function(event, d) {
    d3.select(this).select('circle')
      .attr('fill', d.isExpanded ? '#28a745' : '#6c757d');
  });

  return toggleGroups;
}

/**
 * Update component toggle states (visual update only, no data rebind).
 * @param {d3.Selection} toggleGroups - Selection of toggle groups
 * @param {Map} componentExpansionState - Map of component index to expansion state
 */
export function updateComponentToggles(toggleGroups, componentExpansionState) {
  toggleGroups.each(function(d) {
    const isExpanded = componentExpansionState.get(d.compIdx) === true;
    d.isExpanded = isExpanded;

    const group = d3.select(this);

    // Update circle color
    group.select('circle')
      .attr('fill', isExpanded ? '#28a745' : '#6c757d');

    // Update icon
    group.select('path.toggle-icon')
      .attr('d', isExpanded ? 'M -3 -2 L 0 2 L 3 -2' : 'M -2 -3 L 2 0 L -2 3');
  });
}

/**
 * Show component toggles with fade-in animation.
 * @param {d3.Selection} toggleGroups - Selection of toggle groups
 * @param {number} duration - Animation duration in milliseconds (default: 400)
 */
export function showComponentToggles(toggleGroups, duration = 400) {
  if (toggleGroups && !toggleGroups.empty()) {
    toggleGroups
      .transition()
      .duration(duration)
      .style('opacity', 1);
  }
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
