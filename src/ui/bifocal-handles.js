/**
 * Bifocal Focus Region Handles
 * Provides a horizontal line with two draggable handles for adjusting focus region
 */

/**
 * Create SVG elements for bifocal handles
 *
 * @param {Selection} container - D3 selection to append handles to (SVG element)
 * @param {Object} params - Configuration parameters
 * @param {number} params.xStart - Timeline start pixel
 * @param {number} params.xEnd - Timeline end pixel
 * @param {number} params.axisY - Y position for the handle line
 * @param {number} params.chartHeight - Full chart height (unused, kept for API compatibility)
 * @param {Function} params.getBifocalState - Returns current bifocal state
 * @param {Function} params.onFocusChange - Callback: (newFocusStart, newFocusEnd) => void
 * @param {Object} params.d3 - D3 library reference
 * @returns {Object} - Handle selections and control functions
 */
export function createBifocalHandles(container, params) {
  const {
    xStart: initialXStart,
    xEnd: initialXEnd,
    axisY = 20,
    getBifocalState,
    onFocusChange,
    d3
  } = params;

  let xStart = initialXStart;
  let xEnd = initialXEnd;
  let totalWidth = xEnd - xStart;

  // Get the actual SVG DOM element for pointer calculations
  const svgNode = container.node();

  const handleGroup = container.append('g')
    .attr('class', 'bifocal-handles')
    .style('display', 'none'); // Hidden by default

  // Horizontal track line (background)
  handleGroup.append('line')
    .attr('class', 'bifocal-track')
    .attr('x1', xStart)
    .attr('x2', xEnd)
    .attr('y1', axisY)
    .attr('y2', axisY)
    .style('stroke', '#dee2e6')
    .style('stroke-width', 4)
    .style('stroke-linecap', 'round');

  // Active range line (between handles) - draggable to move entire region
  const rangeLine = handleGroup.append('line')
    .attr('class', 'bifocal-range')
    .attr('y1', axisY)
    .attr('y2', axisY)
    .style('stroke', '#4285f4')
    .style('stroke-width', 4)
    .style('stroke-linecap', 'round')
    .style('cursor', 'grab')
    .style('pointer-events', 'all');

  // Invisible wider hit area for easier dragging of range line
  const rangeHitArea = handleGroup.append('line')
    .attr('class', 'bifocal-range-hitarea')
    .attr('y1', axisY)
    .attr('y2', axisY)
    .style('stroke', 'transparent')
    .style('stroke-width', 16)
    .style('cursor', 'grab')
    .style('pointer-events', 'all');

  // Left handle
  const leftHandle = handleGroup.append('g')
    .attr('class', 'bifocal-handle-left')
    .style('cursor', 'ew-resize')
    .style('pointer-events', 'all');

  leftHandle.append('circle')
    .attr('r', 8)
    .attr('cy', axisY)
    .style('fill', '#4285f4')
    .style('stroke', '#fff')
    .style('stroke-width', 2);

  // Right handle
  const rightHandle = handleGroup.append('g')
    .attr('class', 'bifocal-handle-right')
    .style('cursor', 'ew-resize')
    .style('pointer-events', 'all');

  rightHandle.append('circle')
    .attr('r', 8)
    .attr('cy', axisY)
    .style('fill', '#4285f4')
    .style('stroke', '#fff')
    .style('stroke-width', 2);

  /**
   * Convert pixel X to normalized [0, 1] position
   */
  function pixelToNormalized(px) {
    return Math.max(0, Math.min(1, (px - xStart) / totalWidth));
  }

  /**
   * Update handle positions from current bifocal state
   */
  function updateHandlePositions() {
    const state = getBifocalState();
    const leftPx = xStart + state.focusStart * totalWidth;
    const rightPx = xStart + state.focusEnd * totalWidth;

    // Update range line and hit area
    rangeLine
      .attr('x1', leftPx)
      .attr('x2', rightPx);

    rangeHitArea
      .attr('x1', leftPx)
      .attr('x2', rightPx);

    // Update handle positions
    leftHandle.attr('transform', `translate(${leftPx}, 0)`);
    rightHandle.attr('transform', `translate(${rightPx}, 0)`);
  }

  // Track drag start state
  let dragStartFocusEnd = null;
  let dragStartFocusStart = null;
  let dragStartMouseX = null;
  let _isDragging = false;

  // Drag behavior for left handle
  const dragLeft = d3.drag()
    .on('start', function(event) {
      _isDragging = true;
      const state = getBifocalState();
      dragStartFocusEnd = state.focusEnd;
      d3.select(this).select('circle')
        .style('fill', '#1a73e8')
        .attr('r', 10);
    })
    .on('drag', function(event) {
      const [mouseX] = d3.pointer(event, svgNode);
      const newFocusStart = Math.max(0, Math.min(
        dragStartFocusEnd - 0.02,
        pixelToNormalized(mouseX)
      ));
      onFocusChange(newFocusStart, dragStartFocusEnd);
    })
    .on('end', function() {
      _isDragging = false;
      dragStartFocusEnd = null;
      d3.select(this).select('circle')
        .style('fill', '#4285f4')
        .attr('r', 8);
    });

  // Drag behavior for right handle
  const dragRight = d3.drag()
    .on('start', function(event) {
      _isDragging = true;
      const state = getBifocalState();
      dragStartFocusStart = state.focusStart;
      d3.select(this).select('circle')
        .style('fill', '#1a73e8')
        .attr('r', 10);
    })
    .on('drag', function(event) {
      const [mouseX] = d3.pointer(event, svgNode);
      const newFocusEnd = Math.max(
        dragStartFocusStart + 0.02,
        Math.min(1, pixelToNormalized(mouseX))
      );
      onFocusChange(dragStartFocusStart, newFocusEnd);
    })
    .on('end', function() {
      _isDragging = false;
      dragStartFocusStart = null;
      d3.select(this).select('circle')
        .style('fill', '#4285f4')
        .attr('r', 8);
    });

  // Drag behavior for range line (move entire region)
  const dragRange = d3.drag()
    .on('start', function(event) {
      _isDragging = true;
      const state = getBifocalState();
      dragStartFocusStart = state.focusStart;
      dragStartFocusEnd = state.focusEnd;
      const [mouseX] = d3.pointer(event, svgNode);
      dragStartMouseX = mouseX;
      rangeLine.style('cursor', 'grabbing').style('stroke', '#1a73e8');
      rangeHitArea.style('cursor', 'grabbing');
    })
    .on('drag', function(event) {
      if (dragStartMouseX === null) return;

      const [mouseX] = d3.pointer(event, svgNode);
      const focusSpan = dragStartFocusEnd - dragStartFocusStart;
      const dx = (mouseX - dragStartMouseX) / totalWidth;

      let newStart = dragStartFocusStart + dx;
      let newEnd = dragStartFocusEnd + dx;

      // Clamp to [0, 1]
      if (newStart < 0) {
        newStart = 0;
        newEnd = focusSpan;
      }
      if (newEnd > 1) {
        newEnd = 1;
        newStart = 1 - focusSpan;
      }

      onFocusChange(newStart, newEnd);
    })
    .on('end', function() {
      _isDragging = false;
      dragStartFocusStart = null;
      dragStartFocusEnd = null;
      dragStartMouseX = null;
      rangeLine.style('cursor', 'grab').style('stroke', '#4285f4');
      rangeHitArea.style('cursor', 'grab');
    });

  // Attach drag behaviors
  leftHandle.call(dragLeft);
  rightHandle.call(dragRight);
  rangeLine.call(dragRange);
  rangeHitArea.call(dragRange);

  // Initial position update
  updateHandlePositions();

  return {
    handleGroup,
    updateHandlePositions,
    get isDragging() { return _isDragging; },
    updateLayout: (newXStart, newXEnd) => {
      xStart = newXStart;
      xEnd = newXEnd;
      totalWidth = xEnd - xStart;
      // Update track line
      handleGroup.select('.bifocal-track')
        .attr('x1', xStart)
        .attr('x2', xEnd);
      updateHandlePositions();
    },
    show: () => {
      handleGroup.style('display', null);
      updateHandlePositions();
    },
    hide: () => handleGroup.style('display', 'none'),
    remove: () => handleGroup.remove()
  };
}
