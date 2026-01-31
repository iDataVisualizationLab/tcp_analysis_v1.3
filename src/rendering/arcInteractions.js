// src/rendering/arcInteractions.js
// Arc hover and interaction logic

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

/**
 * Create arc hover handler.
 * @param {Object} config
 * @param {d3.Selection} config.arcPaths - Arc path selection
 * @param {d3.Selection} config.svg - SVG selection
 * @param {Map} config.ipToNode - Map from IP to node object
 * @param {Function} config.widthScale - Scale for arc stroke width
 * @param {Function} config.xScaleLens - X scale with lens distortion
 * @param {Function} config.yScaleLens - Y scale with lens distortion
 * @param {Function} config.colorForAttack - Function to get color for attack type
 * @param {Function} config.showTooltip - Function to show tooltip
 * @param {Function} config.getLabelMode - Getter for label mode ('attack' or 'attack_group')
 * @param {Function} config.toDate - Function to convert minute to Date
 * @param {Function} config.timeFormatter - Function to format time
 * @param {boolean} config.looksAbsolute - Whether timestamps are absolute
 * @param {string} config.unitSuffix - Unit suffix for relative time
 * @param {number} config.base - Base minute for relative time
 * @param {Function} config.getLabelsCompressedMode - Getter for labels compressed mode
 * @param {number} config.marginLeft - Left margin for label fallback position
 * @param {Map} config.ipToComponent - Map from IP to component index (optional)
 * @param {Function} config.getComponentExpansionState - Getter for component expansion state (optional)
 * @returns {Function} Mouseover event handler
 */
export function createArcHoverHandler(config) {
  const {
    arcPaths,
    svg,
    ipToNode,
    widthScale,
    xScaleLens,
    yScaleLens,
    colorForAttack,
    showTooltip,
    getLabelMode,
    toDate,
    timeFormatter,
    looksAbsolute,
    unitSuffix,
    base,
    getLabelsCompressedMode,
    marginLeft,
    ipToComponent,
    getComponentExpansionState
  } = config;

  return function(event, d) {
    const xp = xScaleLens(d.minute);
    const y1 = yScaleLens(d.sourceNode.name);
    const y2 = yScaleLens(d.targetNode.name);

    // Validate positions
    if (!isFinite(xp) || !isFinite(y1) || !isFinite(y2)) {
      console.warn('Invalid positions for hover:', {
        xp, y1, y2,
        minute: d.minute,
        source: d.sourceNode.name,
        target: d.targetNode.name
      });
      return;
    }

    // Highlight hovered arc at 100% opacity, others at 30%
    arcPaths.style('stroke-opacity', p => (p === d ? 1 : 0.3));
    const baseW = widthScale(Math.max(1, d.count));
    d3.select(this)
      .attr('stroke-width', Math.max(3, baseW < 2 ? baseW * 3 : baseW * 1.5))
      .raise();

    // Highlight connected row lines and labels
    const active = new Set([d.sourceNode.name, d.targetNode.name]);

    svg.selectAll('.row-line')
      .attr('stroke-opacity', s => s && s.ip && active.has(s.ip) ? 0.8 : 0.1)
      .attr('stroke-width', s => s && s.ip && active.has(s.ip) ? 1 : 0.4);

    const labelMode = getLabelMode();
    const attackCol = colorForAttack(
      (labelMode === 'attack_group' ? d.attack_group : d.attack) || 'normal'
    );

    const labelSelection = svg.selectAll('.ip-label');
    const labelsCompressedMode = getLabelsCompressedMode();

    labelSelection
      .attr('font-weight', s => active.has(s) ? 'bold' : null)
      .style('font-size', s => active.has(s) ? '14px' : null)
      .style('fill', s => active.has(s) ? attackCol : '#343a40')
      // Ensure endpoint labels are visible even if baseline labels are hidden
      .style('opacity', s => {
        // Always show labels for the active arc endpoints
        if (active.has(s)) return 1;

        // For non-active labels, check component expansion state first
        if (getComponentExpansionState && ipToComponent) {
          const componentExpansionState = getComponentExpansionState();
          const compIdx = ipToComponent.get(s);
          if (compIdx !== undefined) {
            const isExpanded = componentExpansionState.get(compIdx) === true;
            if (!isExpanded) return 0; // Hide if component is collapsed
          }
        }

        // Then check compressed mode for non-active labels
        if (!labelsCompressedMode) return 1;
        return 0; // Hide labels in compressed mode
      });

    // Move the two endpoint labels close to the hovered link's time and align to arc ends
    svg.selectAll('.ip-label')
      .filter(s => active.has(s))
      .transition()
      .duration(200)
      .attr('x', xp)
      .attr('y', s => {
        // Use node's Y position (maintained by updateNodePositions)
        const node = ipToNode.get(s);
        if (node && node.y !== undefined) {
          return node.y;
        }
        // Fallback to scale if node not found
        return yScaleLens(s);
      });

    // Show tooltip
    const dt = toDate(d.minute);
    const timeStr = looksAbsolute ? timeFormatter(dt) : `t=${d.minute - base} ${unitSuffix}`;
    const content = `${d.sourceNode.name} → ${d.targetNode.name}<br>` +
      (labelMode === 'attack_group'
        ? `Attack Group: ${d.attack_group || 'normal'}<br>`
        : `Attack: ${d.attack || 'normal'}<br>`) +
      `${timeStr}<br>` +
      `count=${d.count}`;

    showTooltip(event, content);
  };
}

/**
 * Create arc mousemove handler to keep tooltip following cursor.
 * @param {Object} config
 * @param {HTMLElement} config.tooltip - Tooltip DOM element
 * @returns {Function} Mousemove event handler
 */
export function createArcMoveHandler(config) {
  const { tooltip } = config;

  return function(event) {
    if (tooltip && tooltip.style.display !== 'none') {
      const pad = 10;
      tooltip.style.left = (event.clientX + pad) + 'px';
      tooltip.style.top = (event.clientY + pad) + 'px';
    }
  };
}

/**
 * Create arc mouseout handler.
 * @param {Object} config
 * @param {d3.Selection} config.arcPaths - Arc path selection
 * @param {d3.Selection} config.svg - SVG selection
 * @param {Map} config.ipToNode - Map from IP to node object
 * @param {Function} config.widthScale - Scale for arc stroke width
 * @param {Function} config.hideTooltip - Function to hide tooltip
 * @param {Function} config.yScaleLens - Y scale with lens distortion (fallback)
 * @param {Function} config.getLabelsCompressedMode - Getter for labels compressed mode
 * @param {number} config.marginLeft - Left margin for label fallback position
 * @param {Map} config.ipToComponent - Map from IP to component index (optional)
 * @param {Function} config.getComponentExpansionState - Getter for component expansion state (optional)
 * @returns {Function} Mouseout event handler
 */
export function createArcLeaveHandler(config) {
  const {
    arcPaths,
    svg,
    ipToNode,
    widthScale,
    hideTooltip,
    yScaleLens,
    getLabelsCompressedMode,
    marginLeft,
    ipToComponent,
    getComponentExpansionState
  } = config;

  return function() {
    hideTooltip();

    // Restore default opacity
    arcPaths
      .style('stroke-opacity', 0.6)
      .attr('stroke-width', d => widthScale(Math.max(1, d.count)));

    // Restore row lines
    svg.selectAll('.row-line')
      .attr('stroke-opacity', 1)
      .attr('stroke-width', 0.4);

    // Restore labels
    const labelSelection = svg.selectAll('.ip-label');
    labelSelection
      .attr('font-weight', null)
      .style('font-size', null)
      .style('fill', '#343a40')
      .transition()
      .duration(200)
      .attr('x', s => {
        // Restore to xConnected (strongest connection position)
        const node = ipToNode.get(s);
        return node && node.xConnected !== undefined ? node.xConnected : marginLeft;
      })
      .attr('y', s => {
        // Use node's Y position
        const node = ipToNode.get(s);
        return node && node.y !== undefined ? node.y : yScaleLens(s);
      });

    // Restore opacity according to compressed mode and component expansion state
    const labelsCompressedMode = getLabelsCompressedMode();
    const componentExpansionState = getComponentExpansionState ? getComponentExpansionState() : null;

    labelSelection.style('opacity', s => {
      // Check component expansion state first (if available)
      if (componentExpansionState && ipToComponent) {
        const compIdx = ipToComponent.get(s);
        if (compIdx !== undefined) {
          // If component is collapsed, hide the label
          const isExpanded = componentExpansionState.get(compIdx) === true;
          if (!isExpanded) return 0;
        }
      }

      // Then check compressed mode
      if (!labelsCompressedMode) return 1;
      return 0; // Hide labels in compressed mode
    });
  };
}

/**
 * Attach handlers to arc paths.
 * @param {d3.Selection} arcPaths - Arc path selection
 * @param {Function} hoverHandler - Mouseover handler
 * @param {Function} moveHandler - Mousemove handler
 * @param {Function} leaveHandler - Mouseout handler
 */
export function attachArcHandlers(arcPaths, hoverHandler, moveHandler, leaveHandler) {
  arcPaths
    .on('mouseover', hoverHandler)
    .on('mousemove', moveHandler)
    .on('mouseout', leaveHandler);
}
