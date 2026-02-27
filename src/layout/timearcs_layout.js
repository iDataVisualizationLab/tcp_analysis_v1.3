// TimearcsLayout — Encapsulates the timearcs arc visualization.
// Mirrors the ForceNetworkLayout pattern: one class, constructor options,
// separate setData() and render() calls, pull-based context retrieval.

import { MARGIN, INNER_HEIGHT, MIN_IP_SPACING, MIN_IP_SPACING_WITHIN_COMPONENT, INTER_COMPONENT_GAP, DEFAULT_COLOR, NEUTRAL_GREY } from '../config/constants.js';
import { sanitizeId, showTooltip, hideTooltip, setStatus } from '../utils/helpers.js';
import { linkArc, gradientIdForLink } from '../rendering/arcPath.js';
import { computeIpSpans, createSpanData, renderRowLines, renderIpLabels, renderComponentToggles, updateComponentToggles, showComponentToggles, createLabelHoverHandler, createLabelMoveHandler, createLabelLeaveHandler, attachLabelHoverHandlers } from '../rendering/rows.js';
import { createArcHoverHandler, createArcMoveHandler, createArcLeaveHandler, attachArcHandlers } from '../rendering/arcInteractions.js';
import { createBifocalHandles } from '../ui/bifocal-handles.js';
import { updateFocusRegion, computeLayoutWidths } from '../scales/bifocal.js';
import { createLensXScale } from '../scales/distortion.js';
import { createTimeScale, createIpScale, createWidthScale, detectTimestampUnit, createToDateConverter } from '../scales/scaleFactory.js';
import { createForceSimulation, runUntilConverged, createComponentSeparationForce, createWeakComponentSeparationForce, createComponentCohesionForce, createHubCenteringForce, createComponentYForce, initializeNodePositions, calculateComponentCenters, findComponentHubIps, calculateIpDegrees, calculateConnectionStrength, createMutualHubAttractionForce } from './forceSimulation.js';
import { computeLinks, findConnectedComponents } from '../data/aggregation.js';

export class TimearcsLayout {
  /**
   * @param {object} options
   * @param {object} options.svg          - d3 selection of #chart SVG
   * @param {object} options.container    - DOM element of chart container
   * @param {object} options.tooltip      - DOM element for tooltip
   * @param {number} options.width        - initial width
   * @param {number} options.height       - initial height
   * @param {Function} options.colorForAttack  - (name) => color string
   * @param {Function} options.getLabelMode    - () => 'timearcs'|'force_layout'
   * @param {Function} options.getLayoutMode   - () => 'timearcs'|'force_layout'
   * @param {Function} options.getForceLayout  - () => ForceNetworkLayout|null
   * @param {Function} options.onRenderComplete  - callback(ctx) after animation completes
   * @param {Function} options.onDetailsRequested - callback(selection) for "View Details"
   * @param {Function} options.onSelectionChange  - callback(status) on brush change
   * @param {object}   options.statusEl           - DOM element for status text
   * @param {object}   options.bifocalRegionText  - DOM element for bifocal indicator text
   */
  constructor(options) {
    const {
      svg, container, tooltip,
      width, height,
      colorForAttack, getLabelMode, getLayoutMode, getForceLayout,
      onRenderComplete, onDetailsRequested, onSelectionChange,
      statusEl, bifocalRegionText
    } = options;

    // External references
    this._svg = svg;
    this._container = container;
    this._tooltip = tooltip;
    this._width = width;
    this._height = height;
    this._colorForAttack = colorForAttack;
    this._getLabelMode = getLabelMode;
    this._getLayoutMode = getLayoutMode;
    this._getForceLayout = getForceLayout;
    this._onRenderComplete = onRenderComplete;
    this._onDetailsRequested = onDetailsRequested;
    this._onSelectionChange = onSelectionChange;
    this._statusEl = statusEl;
    this._bifocalRegionText = bifocalRegionText;

    // ── Bifocal state ──────────────────────────────────────────────
    this._bifocalEnabled = true;
    this._bifocalState = {
      focusStart: 0.0,
      focusEnd: 1.0,
      compressionRatio: 3.0,
      leftContextWidth: 0.0,
      focusWidth: 1.0,
      rightContextWidth: 0.0
    };
    this._bifocalHandles = null;

    // ── Brush / selection state ────────────────────────────────────
    this._brushSelection = null;
    this._selectedArcs = [];
    this._selectedIps = new Set();
    this._selectionTimeRange = null;
    this._dragStart = null;
    this._isDragging = false;
    this._multiSelectionsGroup = null;
    this._persistentSelections = [];
    this._selectionIdCounter = 0;
    this._brushGroup = null;
    this._brush = null;

    // ── Component expansion state ──────────────────────────────────
    this._componentExpansionState = new Map();

    // ── Layout cache ───────────────────────────────────────────────
    this._cachedLayoutResult = null;   // { sortedIps } — reused for filtered re-renders
    this._cachedDynamicHeight = null;
    this._labelsCompressedMode = false;
    this._currentSortedIps = [];
    this._renderGeneration = 0;

    // ── Per-render DOM / scale references (populated by render()) ──
    // These survive across render() for use by updateBifocalState(),
    // applyComponentLayout(), and the transition functions.
    this._arcPaths = null;
    this._rows = null;
    this._gradients = null;
    this._componentToggles = null;
    this._xScaleLens = null;
    this._yScaleLens = null;       // closure over _evenlyDistributedYPositions
    this._x = null;                // raw d3 time scale
    this._xStart = null;
    this._currentXEnd = null;
    this._xMinDate = null;
    this._xMaxDate = null;
    this._tsMin = null;
    this._tsMax = null;
    this._looksAbsolute = null;
    this._unit = null;
    this._unitMs = null;
    this._unitSuffix = null;
    this._base = null;
    this._timelineWidth = null;
    this._widthScale = null;
    this._ipToNode = null;
    this._ipToComponent = null;
    this._components = null;
    this._allIps = null;
    this._linksWithNodes = null;
    this._sortedIps = null;
    this._finalY = null;           // ip => final y position after layout
    this._ipSpans = null;
    this._evenlyDistributedYPositions = null;
    this._gradIdForLink = null;
    this._utcTick = null;
    this._data = null;
    this._attacks = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  /**
   * Store processed link/IP data for the next render.
   * Mirrors ForceNetworkLayout.setData().
   */
  setData(linksWithNodes, allIps, ipToComponent, components, activeLabelKey) {
    this._linksWithNodes = linksWithNodes;
    this._allIps = allIps;
    this._ipToComponent = ipToComponent;
    this._components = components;
    this._activeLabelKey = activeLabelKey;
  }

  /**
   * Returns the render context needed by the orchestrator for force layout
   * transitions and export functions.
   *
   * TODO(human): Implement this method.
   * It should return an object with the key references that attack-network.js
   * needs after render() completes:
   *   - linksWithNodes, allIps, ipToComponent, components
   *   - yScaleLens (function: ip => y), xScaleLens (function: ts => x)
   *   - xStart, colorForAttack, tsMin, tsMax
   *
   * Guidance: Think about validation — if render() hasn't run yet, these will
   * all be null. Should you throw, return null, or return partial data?
   * Also consider whether callers should get live references or snapshots.
   */
  getContext() {
    return {
      // Arc/IP data for force layout node+link construction
      linksWithNodes: this._linksWithNodes,
      allIps:         this._allIps,
      ipToComponent:  this._ipToComponent,
      components:     this._components,
      // Scale functions — force layout seeds initial positions from timearcs Y
      yScaleLens:     this._yScaleLens,
      xScaleLens:     this._xScaleLens,
      xStart:         this._xStart,
      // Color + time range — used by bifocal time-filter in force mode
      colorForAttack: this._colorForAttack,
      tsMin:          this._tsMin,
      tsMax:          this._tsMax,
    };
  }

  /** Returns a copy of the current sorted IP order (for export functions). */
  getCurrentSortedIps() {
    return this._currentSortedIps.slice();
  }

  /** Returns the persistent brush selections array. */
  getPersistentSelections() {
    return this._persistentSelections;
  }

  /** Sets bifocal state and triggers a visual update. */
  setBifocalState(newState) {
    this._bifocalState = newState;
    this._updateBifocalVisualization();
  }

  /** Called when the compression slider changes (updates just the ratio). */
  updateBifocalCompression(ratio) {
    this._bifocalState.compressionRatio = ratio;
    const widths = computeLayoutWidths(this._bifocalState);
    this._bifocalState = { ...this._bifocalState, ...widths };
    this._updateBifocalVisualization();
  }

  /** Returns the current bifocal state (read-only snapshot). */
  getBifocalState() {
    return this._bifocalState;
  }

  /**
   * Lightweight resize: stretch/shrink the x-axis without re-running
   * the force simulation or rebuilding any data structures.
   * Reuses _updateBifocalVisualization() for element repositioning.
   */
  updateWidth() {
    if (!this._arcPaths) return;   // nothing rendered yet

    // 1. Recalculate width from container
    const availableWidth = this._container.clientWidth || 1200;
    const viewportWidth = Math.max(availableWidth, 800);
    const newWidth = viewportWidth - MARGIN.left - MARGIN.right;

    if (Math.abs(newWidth - this._width) < 10) return;  // skip tiny changes

    // 2. Derive new xEnd preserving the arc radius offset
    const oldSvgWidth = this._width + MARGIN.left + MARGIN.right;
    const arcRadiusOffset = oldSvgWidth - this._currentXEnd;  // MARGIN.right + maxArcRadius
    const newSvgWidth = newWidth + MARGIN.left + MARGIN.right;
    const newXEnd = newSvgWidth - arcRadiusOffset;

    // 3. Update stored dimensions
    this._width = newWidth;
    this._timelineWidth = newWidth;
    this._currentXEnd = newXEnd;

    // 4. Update base x scale range
    this._x.range([this._xStart, newXEnd]);

    // 5. Update SVG width
    this._svg.attr('width', newSvgWidth);

    // 6. Recreate axis
    const axisSvg = d3.select('#axis-top');
    axisSvg.selectAll('*').remove();
    axisSvg.attr('width', newSvgWidth);
    const axisScale = d3.scaleTime()
      .domain([this._xMinDate, this._xMaxDate])
      .range([0, newXEnd - this._xStart]);
    axisSvg.append('g')
      .attr('transform', `translate(${this._xStart}, 28)`)
      .call(d3.axisTop(axisScale).ticks(7).tickFormat(d => {
        if (this._looksAbsolute) return this._utcTick(d);
        return `t=${Math.round(d.getTime() / this._unitMs)}${this._unitSuffix}`;
      }));

    // 7. Update bifocal bar + handles
    const bifocalBarSvg = d3.select('#bifocal-bar');
    bifocalBarSvg.attr('width', newSvgWidth);
    if (this._bifocalHandles) {
      this._bifocalHandles.updateLayout(this._xStart, newXEnd);
    }

    // 8. Update brush extent
    if (this._brushGroup && this._brush) {
      this._brush.extent([[MARGIN.left, MARGIN.top],
                          [newWidth + MARGIN.left, MARGIN.top + INNER_HEIGHT]]);
      this._brushGroup.call(this._brush);
      this._brushGroup.select('.overlay').style('pointer-events', 'none');
    }

    // 9. Rescale all visual elements (arcs, gradients, rows, labels, selections)
    this._updateBifocalVisualization();
  }

  /** Clears all brush selections and resets state. */
  clearBrushSelection() {
    if (this._brush && this._brushGroup) {
      this._brushGroup.call(this._brush.move, null);
    }
    this._persistentSelections = [];
    if (this._multiSelectionsGroup) {
      this._multiSelectionsGroup.selectAll('.persistent-selection').remove();
    }
    this._brushSelection = null;
    this._selectedArcs = [];
    this._selectedIps.clear();
    this._selectionTimeRange = null;
    this._updateSelectionDisplay();
    if (this._onSelectionChange) this._onSelectionChange('Drag to select');
  }

  /** Recompute component Y positions after expand/collapse, animate to new layout. */
  applyComponentLayout() {
    this._applyComponentLayout();
  }

  /** Redraws all persistent selection visuals at current scale positions. */
  redrawPersistentSelections() {
    this._redrawAllPersistentSelections();
  }

  /** Destroy: stop everything and null DOM references. */
  destroy() {
    this._arcPaths = null;
    this._rows = null;
    this._gradients = null;
    this._componentToggles = null;
    this._brushGroup = null;
    this._brush = null;
    this._multiSelectionsGroup = null;
    this._bifocalHandles = null;
    this._linksWithNodes = null;
    this._allIps = null;
    this._ipToNode = null;
    this._ipToComponent = null;
    this._components = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Main render (timearcs path)
  // ─────────────────────────────────────────────────────────────────

  async render(data, isRenderingFilteredData, originalData) {
    const thisGeneration = ++this._renderGeneration;
    const svg = this._svg;
    const labelMode = this._getLabelMode();
    const layoutMode = this._getLayoutMode();

    // ── Cleanup ───────────────────────────────────────────────────
    svg.selectAll('*').remove();
    d3.select('#axis-top').selectAll('*').remove();
    this._selectedArcs = [];
    this._selectedIps.clear();
    this._brushSelection = null;
    this._selectionTimeRange = null;
    this._multiSelectionsGroup = null;
    this._brushGroup = null;
    this._brush = null;
    this._arcPaths = null;
    this._bifocalHandles = null;
    this._data = data;

    // ── Timestamp detection ───────────────────────────────────────
    const tsMin = d3.min(data, d => d.timestamp);
    const tsMax = d3.max(data, d => d.timestamp);
    const timeInfo = detectTimestampUnit(tsMin, tsMax);
    const { unit, looksAbsolute, unitMs, unitSuffix, base } = timeInfo;
    const toDate = createToDateConverter(timeInfo);

    this._tsMin = tsMin;
    this._tsMax = tsMax;
    this._unit = unit;
    this._looksAbsolute = looksAbsolute;
    this._unitMs = unitMs;
    this._unitSuffix = unitSuffix;
    this._base = base;

    // ── Links / nodes ─────────────────────────────────────────────
    const activeLabelKey = labelMode === 'force_layout' ? 'attack_group' : 'attack';
    const links = computeLinks(data);

    const allIpsFromLinks = new Set();
    links.forEach(l => { allIpsFromLinks.add(l.source); allIpsFromLinks.add(l.target); });

    const nodeData = this._computeNodesByAttackGrouping(links);
    const { nodes, simNodes, simLinks, yMap, components, ipToComponent } = nodeData;
    const ips = nodes.map(n => n.name);
    const allIps = Array.from(new Set([...ips, ...allIpsFromLinks]));

    // Initialize component expansion state on first load
    if (!isRenderingFilteredData && components && components.length > 1) {
      if (this._componentExpansionState.size === 0) {
        components.forEach((_, idx) => this._componentExpansionState.set(idx, false));
      }
    }

    this._allIps = allIps;
    this._ipToComponent = ipToComponent;
    this._components = components;

    // ── Force simulation for IP ordering ─────────────────────────
    const simulation = createForceSimulation(d3, simNodes, simLinks);
    simulation._components = components;
    simulation._ipToComponent = ipToComponent;

    // ── Attacks list ──────────────────────────────────────────────
    const originalLinks = (data === originalData)
      ? links
      : computeLinks(originalData || data);
    const attacks = Array.from(new Set(originalLinks.map(l => l[activeLabelKey] || 'normal'))).sort();
    this._attacks = attacks;

    // ── Dimensions / scales ───────────────────────────────────────
    const availableWidth = this._container.clientWidth || 1200;
    const viewportWidth = Math.max(availableWidth, 800);
    const width = viewportWidth - MARGIN.left - MARGIN.right;
    const height = MARGIN.top + INNER_HEIGHT + MARGIN.bottom;
    this._width = width;
    this._height = height;

    svg.attr('width', width + MARGIN.left + MARGIN.right)
       .attr('height', height)
       .style('user-select', 'none')
       .style('-webkit-user-select', 'none')
       .style('-moz-user-select', 'none')
       .style('-ms-user-select', 'none');

    const xMinDate = toDate(tsMin);
    const xMaxDate = toDate(tsMax);
    this._xMinDate = xMinDate;
    this._xMaxDate = xMaxDate;

    const timelineWidth = width;
    this._timelineWidth = timelineWidth;

    const svgWidth = width + MARGIN.left + MARGIN.right;
    const xStart = MARGIN.left;
    this._xStart = xStart;

    const ipIndexMap = new Map(allIps.map((ip, idx) => [ip, idx]));
    let maxIpIndexDist = 0;
    links.forEach(l => {
      const si = ipIndexMap.get(l.source), ti = ipIndexMap.get(l.target);
      if (si !== undefined && ti !== undefined) {
        const d = Math.abs(si - ti);
        if (d > maxIpIndexDist) maxIpIndexDist = d;
      }
    });
    const estimatedStep = allIps.length > 1 ? INNER_HEIGHT / allIps.length : INNER_HEIGHT;
    const maxArcRadius = (maxIpIndexDist * estimatedStep) / 2;
    const xEnd = svgWidth - MARGIN.right - maxArcRadius;
    let currentXEnd = xEnd;
    this._currentXEnd = currentXEnd;

    const x = createTimeScale(d3, xMinDate, xMaxDate, xStart, xEnd);
    this._x = x;

    const xScaleLens = createLensXScale({
      xScale: x, tsMin, tsMax, xStart, xEnd: xEnd, toDate,
      getBifocalEnabled: () => this._bifocalEnabled,
      getBifocalState: () => this._bifocalState,
      getXEnd: () => this._currentXEnd
    });
    this._xScaleLens = xScaleLens;

    const y = createIpScale(d3, allIps, MARGIN.top, MARGIN.top + INNER_HEIGHT, 0.5);

    this._evenlyDistributedYPositions = null;
    const yScaleLens = (ip) => {
      if (this._evenlyDistributedYPositions && this._evenlyDistributedYPositions.has(ip)) {
        return this._evenlyDistributedYPositions.get(ip);
      }
      return y(ip);
    };
    this._yScaleLens = yScaleLens;

    const minLinkCount = d3.min(links, d => Math.max(1, d.count)) || 1;
    const maxLinkCount = d3.max(links, d => Math.max(1, d.count)) || 1;
    const widthScale = createWidthScale(d3, minLinkCount, maxLinkCount);
    this._widthScale = widthScale;

    const utcTick = d3.utcFormat('%m-%d %H:%M');
    this._utcTick = utcTick;

    const colorForAttack = this._colorForAttack;
    const gradIdForLink = (d) => gradientIdForLink(d, sanitizeId);
    this._gradIdForLink = gradIdForLink;

    // ── Axis ──────────────────────────────────────────────────────
    const axisScale = d3.scaleTime()
      .domain([xMinDate, xMaxDate])
      .range([0, xEnd - xStart]);
    const xAxis = d3.axisTop(axisScale).ticks(7).tickFormat(d => {
      if (looksAbsolute) return utcTick(d);
      const relUnits = Math.round(d.getTime() / unitMs);
      return `t=${relUnits}${unitSuffix}`;
    });
    const axisSvg = d3.select('#axis-top')
      .attr('width', width + MARGIN.left + MARGIN.right)
      .attr('height', 36);
    axisSvg.selectAll('*').remove();
    axisSvg.append('g').attr('transform', `translate(${xStart}, 28)`).call(xAxis);

    // ── Row lines ─────────────────────────────────────────────────
    const rows = svg.append('g');
    this._rows = rows;
    const ipSpans = computeIpSpans(links);
    this._ipSpans = ipSpans;
    const spanData = createSpanData(allIps, ipSpans);
    renderRowLines(rows, spanData, MARGIN.left, yScaleLens);

    // ── Node objects ──────────────────────────────────────────────
    const ipToNode = new Map();
    allIps.forEach(ip => ipToNode.set(ip, { name: ip, x: 0, y: 0 }));
    this._ipToNode = ipToNode;

    const linksWithNodes = links.map(link => {
      const sourceNode = ipToNode.get(link.source);
      const targetNode = ipToNode.get(link.target);
      if (!sourceNode || !targetNode) return null;
      return {
        ...link,
        sourceIp: link.source,
        targetIp: link.target,
        sourceNode,
        targetNode,
        source: sourceNode,
        target: targetNode
      };
    }).filter(l => l !== null);
    this._linksWithNodes = linksWithNodes;

    const updateNodePositions = () => {
      const firstTimeTickX = xScaleLens(tsMin);
      const labelOffset = 15;
      allIps.forEach(ip => {
        const node = ipToNode.get(ip);
        if (node) {
          node.y = yScaleLens(ip);
          node.xConnected = firstTimeTickX - labelOffset;
        }
      });
    };
    updateNodePositions();

    // ── IP Labels ─────────────────────────────────────────────────
    const ipLabels = renderIpLabels(rows, allIps, ipToNode, MARGIN.left, yScaleLens);
    ipLabels.style('opacity', d => {
      const compIdx = ipToComponent.get(d);
      if (compIdx === undefined) return 1;
      return this._componentExpansionState.get(compIdx) === true ? 1 : 0;
    });

    // ── Component toggles ─────────────────────────────────────────
    let componentToggles = null;
    if (components && components.length > 1) {
      componentToggles = renderComponentToggles(
        rows, components, ipToComponent, yScaleLens, MARGIN.left,
        this._componentExpansionState,
        (compIdx) => {
          const wasExpanded = this._componentExpansionState.get(compIdx) === true;
          this._componentExpansionState.set(compIdx, !wasExpanded);
          updateComponentToggles(componentToggles, this._componentExpansionState);
          this._applyComponentLayout();
        },
        (compIdx) => {
          if (this._onDetailsRequested) {
            this._onDetailsRequested({ type: 'exportComponent', compIdx, components, ipToComponent, linksWithNodes, data });
          }
        }
      );
    }
    this._componentToggles = componentToggles;

    // ── Gradients ─────────────────────────────────────────────────
    const defs = svg.append('defs');
    const gradients = defs.selectAll('linearGradient')
      .data(linksWithNodes)
      .join('linearGradient')
      .attr('id', d => gradIdForLink(d))
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', d => xScaleLens(d.minute))
      .attr('x2', d => xScaleLens(d.minute))
      .attr('y1', d => yScaleLens(d.sourceNode.name))
      .attr('y2', d => yScaleLens(d.targetNode.name));

    gradients.each(function(d) {
      const g = d3.select(this);
      g.selectAll('stop').remove();
      g.append('stop').attr('offset', '0%')
        .attr('stop-color', colorForAttack((labelMode === 'force_layout' ? d.attack_group : d.attack) || 'normal'));
      g.append('stop').attr('offset', '100%').attr('stop-color', NEUTRAL_GREY);
    });
    this._gradients = gradients;

    // ── Arc paths ─────────────────────────────────────────────────
    const arcs = svg.append('g');
    const arcPaths = arcs.selectAll('path')
      .data(linksWithNodes)
      .join('path')
      .attr('class', 'arc')
      .attr('data-attack', d => (labelMode === 'force_layout' ? d.attack_group : d.attack) || 'normal')
      .attr('stroke', d => `url(#${gradIdForLink(d)})`)
      .attr('stroke-width', d => widthScale(Math.max(1, d.count)))
      .attr('d', d => {
        const xp = xScaleLens(d.minute);
        const y1 = yScaleLens(d.sourceNode.name);
        const y2 = yScaleLens(d.targetNode.name);
        if (!isFinite(xp) || !isFinite(y1) || !isFinite(y2)) return 'M0,0 L0,0';
        d.source.x = xp; d.source.y = y1;
        d.target.x = xp; d.target.y = y2;
        return linkArc(d);
      });
    this._arcPaths = arcPaths;

    // ── Arc interaction handlers ───────────────────────────────────
    const arcHoverHandler = createArcHoverHandler({
      arcPaths, svg, ipToNode, widthScale,
      xScaleLens: (m) => xScaleLens(m),
      yScaleLens: (ip) => yScaleLens(ip),
      colorForAttack,
      showTooltip: (evt, html) => showTooltip(this._tooltip, evt, html),
      getLabelMode: () => this._getLabelMode(),
      toDate, timeFormatter: utcTick, looksAbsolute, unitSuffix, base,
      getLabelsCompressedMode: () => this._labelsCompressedMode,
      marginLeft: MARGIN.left,
      ipToComponent,
      getComponentExpansionState: () => this._componentExpansionState
    });
    const arcMoveHandler = createArcMoveHandler({ tooltip: this._tooltip });
    const arcLeaveHandler = createArcLeaveHandler({
      arcPaths, svg, ipToNode, widthScale,
      hideTooltip: () => hideTooltip(this._tooltip),
      yScaleLens: (ip) => yScaleLens(ip),
      getLabelsCompressedMode: () => this._labelsCompressedMode,
      marginLeft: MARGIN.left,
      ipToComponent,
      getComponentExpansionState: () => this._componentExpansionState
    });
    attachArcHandlers(arcPaths, arcHoverHandler, arcMoveHandler, arcLeaveHandler);

    // ── Label hover handlers ───────────────────────────────────────
    const labelHoverHandler = createLabelHoverHandler({
      linksWithNodes, arcPaths, svg, widthScale,
      showTooltip, tooltip: this._tooltip, ipToComponent,
      getComponentExpansionState: () => this._componentExpansionState
    });
    const labelMoveHandler = createLabelMoveHandler(this._tooltip);
    const labelLeaveHandler = createLabelLeaveHandler({
      arcPaths, svg, widthScale,
      hideTooltip, tooltip: this._tooltip, ipToComponent,
      getComponentExpansionState: () => this._componentExpansionState
    });
    attachLabelHoverHandlers(ipLabels, labelHoverHandler, labelMoveHandler, labelLeaveHandler);

    // ── Brush setup ───────────────────────────────────────────────
    this._setupDragToBrush(arcPaths, linksWithNodes, xScaleLens, yScaleLens, widthScale, layoutMode);

    // ─────────────────────────────────────────────────────────────
    // If force_layout is the active mode, set hidden arc positions
    // and call back immediately — force layout renders on top.
    // ─────────────────────────────────────────────────────────────
    if (layoutMode === 'force_layout') {
      // Expose context before running the slow simulation
      if (this._onRenderComplete) {
        this._onRenderComplete(this.getContext());
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Force simulation for IP vertical ordering
    // ─────────────────────────────────────────────────────────────
    const canReuseCachedLayout = isRenderingFilteredData && this._cachedLayoutResult;
    setStatus(this._statusEl, 'Stabilizing network layout...');
    const centerX = (MARGIN.left + width - MARGIN.right) / 2;

    if (!canReuseCachedLayout) {
      const ipDegree = calculateIpDegrees(linksWithNodes);
      const connectionStrength = calculateConnectionStrength(linksWithNodes);
      const componentHubIps = findComponentHubIps(components, ipDegree);

      if (components.length > 1) {
        const componentSpacing = INNER_HEIGHT / components.length;
        const componentCenters = calculateComponentCenters(components, MARGIN.top, INNER_HEIGHT);
        initializeNodePositions(simNodes, ipToComponent, componentCenters, centerX, ipDegree, componentSpacing);

        simulation.force('y', createComponentYForce(d3, ipToComponent, componentCenters, MARGIN.top + INNER_HEIGHT / 2));
        simulation.force('componentSeparation', createComponentSeparationForce(ipToComponent, simNodes, { separationStrength: 1.8, minDistance: 100 }));
        simulation.force('componentCohesion', createComponentCohesionForce(ipToComponent, simNodes));
        simulation.force('hubCentering', createHubCenteringForce(componentHubIps, componentCenters, simNodes));
        simulation.force('hubAttraction', createMutualHubAttractionForce(ipToComponent, connectionStrength, simNodes, { attractionStrength: 0.8, hubThreshold: 0.3 }));

        simulation.alpha(0.4).restart();
        await runUntilConverged(simulation, 350, 0.001);
        if (thisGeneration !== this._renderGeneration) return;

        simulation.force('y').strength(0.4);
        simulation.force('componentSeparation', createWeakComponentSeparationForce(ipToComponent, simNodes, { separationStrength: 0.5, minDistance: 60 }));
        simulation.alpha(0.18).restart();
        await runUntilConverged(simulation, 225, 0.0005);
        if (thisGeneration !== this._renderGeneration) return;
      } else {
        const componentCenter = (MARGIN.top + INNER_HEIGHT) / 2;
        const hubIp = componentHubIps.get(0) || null;
        const sortedNodes = [...simNodes].sort((a, b) => {
          const da = ipDegree.get(a.id) || 0, db = ipDegree.get(b.id) || 0;
          if (db !== da) return db - da;
          return a.id.localeCompare(b.id);
        });
        sortedNodes.forEach((n, idx) => {
          n.x = centerX;
          const spread = Math.min(INNER_HEIGHT * 0.3, 50);
          const step = spread / Math.max(1, sortedNodes.length - 1);
          n.y = componentCenter + (idx - (sortedNodes.length - 1) / 2) * step;
          n.vx = 0; n.vy = 0;
        });
        if (hubIp) {
          simulation.force('hubCentering', createHubCenteringForce(new Map([[0, hubIp]]), new Map([[0, componentCenter]]), simNodes, { hubStrength: 1.0 }));
        }
        const singleIpToComp = new Map();
        simNodes.forEach(n => singleIpToComp.set(n.id, 0));
        simulation.force('hubAttraction', createMutualHubAttractionForce(singleIpToComp, connectionStrength, simNodes, { attractionStrength: 0.6, hubThreshold: 0.3 }));
        simulation.alpha(0.15).restart();
        await runUntilConverged(simulation, 200, 0.001);
        if (thisGeneration !== this._renderGeneration) return;
      }

      simulation.stop();
      simulation.force('y', null);
      simulation.force('componentSeparation', null);
      simulation.force('componentCohesion', null);
      simulation.force('hubCentering', null);

      simNodes.forEach(n => {
        yMap.set(n.id, isFinite(n.y) ? n.y : (MARGIN.top + INNER_HEIGHT) / 2);
      });

      // Chronological ordering
      const earliestTime = new Map();
      linksWithNodes.forEach(link => {
        const si = link.sourceNode.name, ti = link.targetNode.name, t = link.minute;
        if (!earliestTime.has(si) || t < earliestTime.get(si)) earliestTime.set(si, t);
        if (!earliestTime.has(ti) || t < earliestTime.get(ti)) earliestTime.set(ti, t);
      });

      this._compactIPPositions(simNodes, yMap, MARGIN.top, INNER_HEIGHT, components, ipToComponent, earliestTime);

      let maxY = MARGIN.top + 12;
      simNodes.forEach(n => { const yv = yMap.get(n.id); if (yv > maxY) maxY = yv; });
      allIps.forEach(ip => {
        if (!yMap.has(ip)) { maxY += 15; yMap.set(ip, maxY); }
      });

      const sortedIpsFull = [...allIps].sort((a, b) => (yMap.get(a) || 0) - (yMap.get(b) || 0));
      this._cachedLayoutResult = { sortedIps: sortedIpsFull };
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Compute final Y positions
    // ─────────────────────────────────────────────────────────────
    setStatus(this._statusEl, 'Animating to timeline...');
    const currentIpSet = new Set(allIps);
    const sortedIps = this._cachedLayoutResult.sortedIps.filter(ip => currentIpSet.has(ip));
    this._currentSortedIps = sortedIps.slice();
    this._sortedIps = sortedIps;

    const finalYMap = new Map();
    let dynamicInnerHeight;

    if (components && components.length > 1) {
      const componentGroups = [];
      sortedIps.forEach(ip => {
        const compIdx = ipToComponent.get(ip);
        if (compIdx !== undefined) {
          if (!componentGroups[compIdx]) componentGroups[compIdx] = [];
          componentGroups[compIdx].push(ip);
        }
      });
      const nonEmptyGroups = componentGroups.filter(g => g && g.length > 0);
      let currentY = MARGIN.top + 12;
      nonEmptyGroups.forEach((group, idx) => {
        const isExpanded = this._componentExpansionState.get(idx) === true;
        const spacing = isExpanded ? MIN_IP_SPACING_WITHIN_COMPONENT : MIN_IP_SPACING;
        group.forEach(ip => { finalYMap.set(ip, currentY); currentY += spacing; });
        if (idx < nonEmptyGroups.length - 1) currentY += INTER_COMPONENT_GAP;
      });
      dynamicInnerHeight = Math.max(INNER_HEIGHT, currentY - MARGIN.top + 25);
    } else {
      const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15));
      dynamicInnerHeight = Math.max(INNER_HEIGHT, 12 + sortedIps.length * step + 25);
      for (let i = 0; i < sortedIps.length; i++) {
        finalYMap.set(sortedIps[i], MARGIN.top + 12 + i * step);
      }
    }

    const dynamicHeight = MARGIN.top + dynamicInnerHeight + MARGIN.bottom;
    if (!this._getForceLayout()) svg.attr('height', dynamicHeight);
    this._cachedDynamicHeight = dynamicHeight;

    const finalY = (ip) => finalYMap.get(ip);
    this._finalY = finalY;

    // Recalculate x-scale to fit arcs
    let actualMaxArcRadius = 0;
    linksWithNodes.forEach(l => {
      const y1 = finalY(l.sourceNode.name), y2 = finalY(l.targetNode.name);
      if (y1 !== undefined && y2 !== undefined) {
        const r = Math.abs(y2 - y1) / 2;
        if (r > actualMaxArcRadius) actualMaxArcRadius = r;
      }
    });
    const actualXEnd = svgWidth - MARGIN.right - actualMaxArcRadius;
    this._currentXEnd = actualXEnd;
    x.range([xStart, actualXEnd]);

    const axisSvgUpdate = d3.select('#axis-top');
    axisSvgUpdate.selectAll('*').remove();
    axisSvgUpdate.append('g')
      .attr('transform', `translate(${xStart}, 28)`)
      .call(d3.axisTop(
        d3.scaleTime().domain([xMinDate, xMaxDate]).range([0, actualXEnd - xStart])
      ).ticks(7).tickFormat(d => {
        if (looksAbsolute) return utcTick(d);
        return `t=${Math.round(d.getTime() / unitMs)}${unitSuffix}`;
      }));

    const finalSpanData = createSpanData(sortedIps, ipSpans);

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Animate (timearcs) or position-only (force_layout)
    // ─────────────────────────────────────────────────────────────
    if (layoutMode === 'force_layout') {
      // Hidden positioning for force layout handoff
      arcPaths.attr('d', d => {
        const xp = xScaleLens(d.minute);
        const a = finalY(d.sourceNode.name), b = finalY(d.targetNode.name);
        if (!isFinite(xp) || !isFinite(a) || !isFinite(b)) return 'M0,0 L0,0';
        d.source.x = xp; d.source.y = a; d.target.x = xp; d.target.y = b;
        return linkArc(d);
      }).style('display', 'none');

      rows.selectAll('line')
        .data(finalSpanData, d => d.ip)
        .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
        .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
        .attr('y1', d => finalY(d.ip)).attr('y2', d => finalY(d.ip))
        .style('opacity', 0).style('pointer-events', 'none');

      rows.selectAll('text')
        .data(sortedIps, d => d)
        .attr('y', d => finalY(d))
        .attr('x', d => { const node = ipToNode.get(d); return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left; })
        .style('opacity', 0).style('pointer-events', 'none');

      if (componentToggles && !componentToggles.empty()) {
        componentToggles.style('opacity', 0).style('pointer-events', 'none');
      }

      linksWithNodes.forEach(d => {
        svg.select(`#${gradIdForLink(d)}`)
          .attr('y1', finalY(d.sourceNode.name))
          .attr('y2', finalY(d.targetNode.name));
      });

      this._evenlyDistributedYPositions = new Map();
      sortedIps.forEach(ip => this._evenlyDistributedYPositions.set(ip, finalY(ip)));
      updateNodePositions();

      if (this._brushGroup && this._brush) {
        this._brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, dynamicHeight]]);
        this._brushGroup.call(this._brush);
      }

      if (this._persistentSelections.length > 0) this._redrawAllPersistentSelections();

    } else {
      // ── Timearcs animation ──────────────────────────────────────
      rows.selectAll('line')
        .data(finalSpanData, d => d.ip)
        .transition().duration(1200)
        .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
        .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
        .tween('y-line', function(d) {
          const yStart = y(d.ip), yEnd = finalY(d.ip);
          const interp = d3.interpolateNumber(yStart, yEnd);
          const self = d3.select(this);
          return t => { const yy = interp(t); self.attr('y1', yy).attr('y2', yy); };
        })
        .style('opacity', 1);

      const finalIpLabelsSelection = rows.selectAll('text').data(sortedIps, d => d);

      // Inline label hover (matches original behaviour)
      finalIpLabelsSelection
        .on('mouseover', function(event, hoveredIp) {
          const connectedArcs = linksWithNodes.filter(l => l.sourceNode.name === hoveredIp || l.targetNode.name === hoveredIp);
          const connectedIps = new Set();
          connectedArcs.forEach(l => { connectedIps.add(l.sourceNode.name); connectedIps.add(l.targetNode.name); });
          arcPaths.style('stroke-opacity', d => (d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp) ? 1 : 0.2)
            .attr('stroke-width', d => {
              if (d.sourceNode.name === hoveredIp || d.targetNode.name === hoveredIp) {
                const bw = widthScale(Math.max(1, d.count));
                return Math.max(3, bw < 2 ? bw * 2.5 : bw * 1.3);
              }
              return widthScale(Math.max(1, d.count));
            });
          svg.selectAll('.row-line')
            .attr('stroke-opacity', s => s && s.ip && connectedIps.has(s.ip) ? 0.8 : 0.1)
            .attr('stroke-width', s => s && s.ip && connectedIps.has(s.ip) ? 1 : 0.4);
          svg.selectAll('.ip-label')
            .attr('font-weight', s => {
              if (s === hoveredIp) return 'bold';
              return connectedIps.has(s) ? '500' : null;
            })
            .style('font-size', s => connectedIps.has(s) ? '14px' : null)
            .style('fill', s => connectedIps.has(s) ? '#000' : '#343a40')
            .style('opacity', s => connectedIps.has(s) ? null : 0.25);
          const content = `IP: ${hoveredIp}<br>Connected arcs: ${connectedArcs.length}<br>Unique connections: ${new Set(connectedArcs.map(l => l.sourceNode.name === hoveredIp ? l.targetNode.name : l.sourceNode.name)).size}`;
          showTooltip(this._tooltip, event, content);
        }.bind(this))
        .on('mousemove', function(event) {
          const tt = this._tooltip;
          if (tt && tt.style.display !== 'none') {
            tt.style.left = (event.clientX + 10) + 'px';
            tt.style.top = (event.clientY + 10) + 'px';
          }
        }.bind(this))
        .on('mouseout', function() {
          hideTooltip(this._tooltip);
          arcPaths.style('stroke-opacity', 0.6).attr('stroke-width', d => widthScale(Math.max(1, d.count)));
          svg.selectAll('.row-line').attr('stroke-opacity', 1).attr('stroke-width', 0.4);
          svg.selectAll('.ip-label').attr('font-weight', null).style('font-size', null).style('fill', '#343a40')
            .style('opacity', d => {
              const compIdx = ipToComponent.get(d);
              if (compIdx === undefined) return 1;
              return this._componentExpansionState.get(compIdx) === true ? 1 : 0;
            });
        }.bind(this));

      updateNodePositions();
      finalIpLabelsSelection
        .transition().duration(1200)
        .tween('y-text', function(d) {
          const yStart = y(d), yEnd = finalY(d);
          const interp = d3.interpolateNumber(yStart, yEnd);
          const self = d3.select(this);
          return t => self.attr('y', interp(t));
        })
        .attr('x', d => { const node = ipToNode.get(d); return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left; })
        .style('opacity', d => {
          const compIdx = ipToComponent.get(d);
          if (compIdx === undefined) return 1;
          return this._componentExpansionState.get(compIdx) === true ? 1 : 0;
        })
        .text(d => d);

      arcPaths.transition().duration(1200)
        .attrTween('d', function(d) {
          const xp = xScaleLens(d.minute);
          const y1Start = y(d.sourceNode.name), y2Start = y(d.targetNode.name);
          const y1End = finalY(d.sourceNode.name) ?? y1Start;
          const y2End = finalY(d.targetNode.name) ?? y2Start;
          if (!isFinite(xp) || !isFinite(y1End) || !isFinite(y2End)) return () => 'M0,0 L0,0';
          return t => {
            d.source.x = xp; d.source.y = y1Start + (y1End - y1Start) * t;
            d.target.x = xp; d.target.y = y2Start + (y2End - y2Start) * t;
            return linkArc(d);
          };
        })
        .on('end', (d, i) => {
          const xp = xScaleLens(d.minute);
          svg.select(`#${gradIdForLink(d)}`)
            .attr('x1', xp).attr('x2', xp)
            .attr('y1', finalY(d.sourceNode.name))
            .attr('y2', finalY(d.targetNode.name));

          if (i === 0) {
            arcPaths.attr('d', dd => {
              const xp2 = xScaleLens(dd.minute), a = finalY(dd.sourceNode.name), b = finalY(dd.targetNode.name);
              if (!isFinite(xp2) || !isFinite(a) || !isFinite(b)) return 'M0,0 L0,0';
              dd.source.x = xp2; dd.source.y = a; dd.target.x = xp2; dd.target.y = b;
              return linkArc(dd);
            });

            this._evenlyDistributedYPositions = new Map();
            sortedIps.forEach(ip => this._evenlyDistributedYPositions.set(ip, finalY(ip)));
            updateNodePositions();

            if (componentToggles && !componentToggles.empty()) {
              componentToggles.attr('transform', d => `translate(8, ${finalY(d.ip)})`);
              showComponentToggles(componentToggles, 400);
            }

            if (this._brushGroup && this._brush) {
              this._brush.extent([[MARGIN.left, MARGIN.top], [width + MARGIN.left, dynamicHeight]]);
              this._brushGroup.call(this._brush);
            }

            setStatus(this._statusEl, `${data.length} records • ${sortedIps.length} IPs • ${attacks.length} ${labelMode === 'force_layout' ? 'attack groups' : 'attack types'}`);

            if (this._persistentSelections.length > 0) this._redrawAllPersistentSelections();

            // Notify orchestrator that render is complete
            if (this._onRenderComplete) this._onRenderComplete(this.getContext());
          }
        });
    } // end timearcs animation

    // ── Bifocal handles ───────────────────────────────────────────
    const bifocalBarSvg = d3.select('#bifocal-bar');
    bifocalBarSvg.attr('width', width + MARGIN.left + MARGIN.right).attr('height', 28);
    bifocalBarSvg.selectAll('*').remove();
    this._bifocalHandles = createBifocalHandles(bifocalBarSvg, {
      xStart, xEnd: this._currentXEnd, axisY: 14, chartHeight: 28,
      getBifocalState: () => this._bifocalState,
      onFocusChange: (newStart, newEnd) => {
        this._bifocalState = updateFocusRegion(this._bifocalState, newStart, newEnd);
        this._updateBifocalVisualization();
      },
      d3
    });
    this._bifocalHandles.show();
    this._updateBifocalRegionText();
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  _updateBifocalRegionText() {
    if (this._bifocalRegionText) {
      const s = Math.round(this._bifocalState.focusStart * 100);
      const e = Math.round(this._bifocalState.focusEnd * 100);
      this._bifocalRegionText.textContent = `Focus: ${s}% - ${e}%`;
    }
  }

  _updateBifocalVisualization() {
    const forceLayout = this._getForceLayout();
    const layoutMode = this._getLayoutMode();

    if (layoutMode === 'force_layout' && forceLayout) {
      const { focusStart: fs, focusEnd: fe } = this._bifocalState;
      if (fs <= 0.01 && fe >= 0.99) {
        forceLayout.updateTimeFilter(null);
      } else {
        const min = this._tsMin + fs * (this._tsMax - this._tsMin);
        const max = this._tsMin + fe * (this._tsMax - this._tsMin);
        forceLayout.updateTimeFilter({ min, max });
      }
      this._updateBifocalRegionText();
      if (this._bifocalHandles) this._bifocalHandles.updateHandlePositions();
      return;
    }

    if (!this._arcPaths) return;

    const xScaleLens = this._xScaleLens;
    const yScaleLens = this._yScaleLens;
    const arcPaths = this._arcPaths;
    const rows = this._rows;
    const gradients = this._gradients;
    const ipToNode = this._ipToNode;
    const ipToComponent = this._ipToComponent;
    const linksWithNodes = this._linksWithNodes;
    const componentToggles = this._componentToggles;
    const allIps = this._allIps;

    const dragging = this._bifocalHandles && this._bifocalHandles.isDragging;
    const dur = dragging ? 0 : 250;

    const arcSel = dur > 0 ? arcPaths.transition().duration(dur) : arcPaths;
    arcSel.attr('d', d => {
      const xp = xScaleLens(d.minute);
      const y1 = yScaleLens(d.sourceNode.name), y2 = yScaleLens(d.targetNode.name);
      d.source.x = xp; d.source.y = y1; d.target.x = xp; d.target.y = y2;
      return linkArc(d);
    });

    const gradSel = dur > 0 ? gradients.transition().duration(dur) : gradients;
    gradSel
      .attr('x1', d => xScaleLens(d.minute)).attr('x2', d => xScaleLens(d.minute))
      .attr('y1', d => yScaleLens(d.sourceNode.name)).attr('y2', d => yScaleLens(d.targetNode.name));

    const lineSel = dur > 0 ? rows.selectAll('line').transition().duration(dur) : rows.selectAll('line');
    lineSel
      .attr('x1', d => d.span ? xScaleLens(d.span.min) : MARGIN.left)
      .attr('x2', d => d.span ? xScaleLens(d.span.max) : MARGIN.left)
      .attr('y1', d => yScaleLens(d.ip)).attr('y2', d => yScaleLens(d.ip));

    // update node positions via the per-render updateNodePositions closure
    allIps.forEach(ip => {
      const node = ipToNode.get(ip);
      if (node) {
        node.y = yScaleLens(ip);
        node.xConnected = xScaleLens(this._tsMin) - 15;
      }
    });

    const textSel = dur > 0 ? rows.selectAll('text').transition().duration(dur) : rows.selectAll('text');
    textSel
      .attr('y', d => yScaleLens(d))
      .attr('x', d => { const node = ipToNode.get(d); return node && node.xConnected !== undefined ? node.xConnected : MARGIN.left; })
      .style('opacity', d => {
        const compIdx = ipToComponent.get(d);
        if (compIdx === undefined) return 1;
        return this._componentExpansionState.get(compIdx) === true ? 1 : 0;
      });

    if (componentToggles && !componentToggles.empty()) {
      const toggleSel = dur > 0 ? componentToggles.transition().duration(dur) : componentToggles;
      toggleSel.attr('transform', d => `translate(8, ${yScaleLens(d.ip)})`);
    }

    // Update axis ticks
    const axisGroup = d3.select('#axis-top').select('g');
    const tempScale = d3.scaleTime().domain([this._xMinDate, this._xMaxDate]).range([0, this._timelineWidth]);
    const tickValues = tempScale.ticks(7);
    const tickSel = dur > 0
      ? axisGroup.selectAll('.tick').data(tickValues).transition().duration(dur)
      : axisGroup.selectAll('.tick').data(tickValues);
    tickSel.attr('transform', d => {
      let ts;
      if (this._looksAbsolute) {
        if (this._unit === 'microseconds') ts = d.getTime() * 1000;
        else if (this._unit === 'milliseconds') ts = d.getTime();
        else if (this._unit === 'seconds') ts = d.getTime() / 1000;
        else if (this._unit === 'minutes') ts = d.getTime() / 60000;
        else ts = d.getTime() / 3600000;
      } else {
        ts = d.getTime() / this._unitMs + this._base;
      }
      return `translate(${xScaleLens(ts) - this._xStart},0)`;
    });

    if (this._bifocalHandles) this._bifocalHandles.updateHandlePositions();
    this._updateBifocalRegionText();
    this._updatePersistentSelectionVisuals();
  }

  _applyComponentLayout() {
    const { _rows: rows, _arcPaths: arcPaths, _gradients: gradients,
            _xScaleLens: xScaleLens, _yScaleLens: yScaleLens,
            _sortedIps: sortedIps, _ipToComponent: ipToComponent,
            _componentExpansionState: componentExpansionState,
            _components: components, _ipToNode: ipToNode,
            _componentToggles: componentToggles, _gradIdForLink: gradIdForLink,
            _linksWithNodes: linksWithNodes, _brushGroup: brushGroup,
            _brush: brush, _svg: svg } = this;

    if (!rows || !arcPaths || !sortedIps) return;

    const newFinalYMap = new Map();
    let currentY = MARGIN.top + 12;

    if (components && components.length > 1) {
      const componentGroups = [];
      sortedIps.forEach(ip => {
        const compIdx = ipToComponent.get(ip);
        if (compIdx !== undefined) {
          if (!componentGroups[compIdx]) componentGroups[compIdx] = [];
          componentGroups[compIdx].push(ip);
        }
      });
      const nonEmptyGroups = componentGroups.filter(g => g && g.length > 0);
      nonEmptyGroups.forEach((group, idx) => {
        const isExpanded = componentExpansionState.get(idx) === true;
        const spacing = isExpanded ? MIN_IP_SPACING_WITHIN_COMPONENT : MIN_IP_SPACING;
        group.forEach(ip => { newFinalYMap.set(ip, currentY); currentY += spacing; });
        if (idx < nonEmptyGroups.length - 1) currentY += INTER_COMPONENT_GAP;
      });
    } else {
      const step = Math.max(MIN_IP_SPACING, Math.min((INNER_HEIGHT - 25) / (sortedIps.length + 1), 15));
      for (let i = 0; i < sortedIps.length; i++) {
        newFinalYMap.set(sortedIps[i], MARGIN.top + 12 + i * step);
      }
    }

    const newDynamicHeight = Math.max(INNER_HEIGHT, currentY - MARGIN.top + 25);
    const dur = 600;

    rows.selectAll('line').transition().duration(dur)
      .attr('y1', d => newFinalYMap.get(d.ip)).attr('y2', d => newFinalYMap.get(d.ip));

    rows.selectAll('text').transition().duration(dur)
      .attr('y', d => newFinalYMap.get(d))
      .style('opacity', d => {
        const compIdx = ipToComponent.get(d);
        if (compIdx === undefined) return 1;
        return componentExpansionState.get(compIdx) === true ? 1 : 0;
      });

    if (componentToggles && !componentToggles.empty()) {
      componentToggles.transition().duration(dur)
        .attr('transform', d => `translate(8, ${newFinalYMap.get(d.ip)})`);
      updateComponentToggles(componentToggles, componentExpansionState);
    }

    arcPaths.transition().duration(dur)
      .attrTween('d', function(d) {
        const xp = xScaleLens(d.minute);
        const y1s = yScaleLens(d.sourceNode.name), y2s = yScaleLens(d.targetNode.name);
        const y1e = newFinalYMap.get(d.sourceNode.name) ?? y1s;
        const y2e = newFinalYMap.get(d.targetNode.name) ?? y2s;
        return t => {
          d.source.x = xp; d.source.y = y1s + (y1e - y1s) * t;
          d.target.x = xp; d.target.y = y2s + (y2e - y2s) * t;
          return linkArc(d);
        };
      })
      .on('end', (d, i) => {
        if (i === 0) {
          this._evenlyDistributedYPositions = newFinalYMap;
          svg.attr('height', newDynamicHeight);
          if (brushGroup && brush) {
            brush.extent([[MARGIN.left, MARGIN.top], [this._width + MARGIN.left, newDynamicHeight]]);
            brushGroup.call(brush);
          }
          if (this._persistentSelections.length > 0) this._redrawAllPersistentSelections();
        }
      });

    linksWithNodes.forEach(d => {
      svg.select(`#${gradIdForLink(d)}`).transition().duration(dur)
        .attr('y1', newFinalYMap.get(d.sourceNode.name))
        .attr('y2', newFinalYMap.get(d.targetNode.name));
    });
  }

  _setupDragToBrush(arcPaths, linksWithNodes, xScaleLens, yScaleLens, widthScale, layoutMode) {
    if (this._brushGroup) return;
    const svg = this._svg;
    const DRAG_THRESHOLD = 8;

    const brush = d3.brush()
      .extent([[MARGIN.left, MARGIN.top], [this._width + MARGIN.left, MARGIN.top + INNER_HEIGHT]])
      .on('start', () => { if (this._onSelectionChange) this._onSelectionChange('Selecting...'); })
      .on('brush', event => {
        if (!event.selection) return;
        const [[x0, y0], [x1, y1]] = event.selection;
        this._brushSelection = { x0, y0, x1, y1 };
      })
      .on('end', event => {
        if (this._brushGroup) this._brushGroup.select('.overlay').style('pointer-events', 'none');
        if (!event.selection) {
          this._brushSelection = null;
          this._selectedArcs = [];
          this._selectedIps.clear();
          this._selectionTimeRange = null;
          const msg = this._persistentSelections.length > 0
            ? `${this._persistentSelections.length} selection${this._persistentSelections.length > 1 ? 's' : ''} saved`
            : 'Drag to select';
          if (this._onSelectionChange) this._onSelectionChange(msg);
        }
      });

    this._brush = brush;
    const brushGroup = svg.append('g').attr('class', 'brush-group').call(brush);
    this._brushGroup = brushGroup;
    brushGroup.selectAll('.selection')
      .style('fill', '#007bff').style('fill-opacity', 0.15)
      .style('stroke', '#007bff').style('stroke-width', 2).style('stroke-dasharray', '5,5');
    brushGroup.select('.overlay').style('pointer-events', 'none');

    if (!this._multiSelectionsGroup) {
      this._multiSelectionsGroup = svg.insert('g', '.brush-group').attr('class', 'multi-selections-group');
    }

    svg.on('mousedown.dragbrush', event => {
      if (layoutMode === 'force_layout' && event.target.closest('.force-node')) return;
      if (event.target.closest('.persistent-selection')) return;
      if (event.target.closest('.brush-group .handle')) return;
      if (event.button !== 0) return;
      this._dragStart = d3.pointer(event, svg.node());
      this._isDragging = false;
    });

    svg.on('mousemove.dragbrush', event => {
      if (!this._dragStart) return;
      const current = d3.pointer(event, svg.node());
      const dist = Math.hypot(current[0] - this._dragStart[0], current[1] - this._dragStart[1]);
      if (!this._isDragging && dist > DRAG_THRESHOLD) {
        this._isDragging = true;
        event.preventDefault();
        arcPaths.style('pointer-events', 'none');
        brushGroup.select('.overlay').style('pointer-events', 'all');
      }
      if (this._isDragging) {
        event.preventDefault();
        const x0 = Math.min(this._dragStart[0], current[0]);
        const y0 = Math.min(this._dragStart[1], current[1]);
        const x1 = Math.max(this._dragStart[0], current[0]);
        const y1 = Math.max(this._dragStart[1], current[1]);
        brushGroup.call(brush.move, [[x0, y0], [x1, y1]]);
      }
    });

    svg.on('mouseup.dragbrush', event => {
      if (this._isDragging && this._dragStart) {
        const current = d3.pointer(event, svg.node());
        const x0 = Math.min(this._dragStart[0], current[0]);
        const y0 = Math.min(this._dragStart[1], current[1]);
        const x1 = Math.max(this._dragStart[0], current[0]);
        const y1 = Math.max(this._dragStart[1], current[1]);
        this._finalizeBrushSelection(x0, y0, x1, y1, arcPaths, linksWithNodes, xScaleLens, yScaleLens, widthScale);
        brushGroup.call(brush.move, null);
        brushGroup.select('.overlay').style('pointer-events', 'none');
        arcPaths.style('pointer-events', null);
      }
      this._dragStart = null;
      this._isDragging = false;
    });

    svg.on('mouseleave.dragbrush', () => {
      if (this._isDragging) arcPaths.style('pointer-events', null);
      this._dragStart = null;
      this._isDragging = false;
    });
  }

  _finalizeBrushSelection(x0, y0, x1, y1, arcPaths, linksWithNodes, xScaleLens, yScaleLens, widthScale) {
    const forceLayout = this._getForceLayout();
    const layoutMode = this._getLayoutMode();

    if (layoutMode === 'force_layout' && forceLayout) {
      const nodePositions = forceLayout.getVisualNodePositions();
      this._selectedArcs = [];
      this._selectedIps.clear();
      for (const [ip, pos] of nodePositions) {
        if (pos.x >= x0 && pos.x <= x1 && pos.y >= y0 && pos.y <= y1) this._selectedIps.add(ip);
      }
      if (this._selectedIps.size > 0) {
        let minTime = Infinity, maxTime = -Infinity;
        linksWithNodes.forEach(link => {
          if (this._selectedIps.has(link.sourceNode.name) && this._selectedIps.has(link.targetNode.name)) {
            this._selectedArcs.push(link);
            if (link.minute < minTime) minTime = link.minute;
            if (link.minute > maxTime) maxTime = link.minute;
          }
        });
        this._selectionTimeRange = { min: minTime, max: minTime === maxTime ? minTime + 1 : maxTime + 1 };
        const sel = {
          id: ++this._selectionIdCounter,
          timeBounds: { minTime, maxTime, minY: y0, maxY: y1 },
          pixelBounds: { x0, y0, x1, y1 },
          arcs: [...this._selectedArcs], ips: new Set(this._selectedIps),
          timeRange: { ...this._selectionTimeRange }
        };
        this._persistentSelections.push(sel);
        this._createPersistentSelectionVisual(sel);
        this._updateSelectionDisplay(arcPaths, widthScale);
        const msg = `${this._persistentSelections.length} selection${this._persistentSelections.length > 1 ? 's' : ''} saved`;
        if (this._onSelectionChange) this._onSelectionChange(msg);
      } else {
        this._selectionTimeRange = null;
        if (this._onSelectionChange) this._onSelectionChange('No nodes selected');
        setTimeout(() => { if (this._onSelectionChange) this._onSelectionChange('Drag to select'); }, 1500);
      }
      return;
    }

    // Timearcs mode
    this._selectedArcs = [];
    this._selectedIps.clear();
    let minTime = Infinity, maxTime = -Infinity, minY = Infinity, maxY = -Infinity;
    linksWithNodes.forEach(link => {
      const xp = xScaleLens(link.minute);
      const sy = yScaleLens(link.sourceNode.name), ty = yScaleLens(link.targetNode.name);
      if (xp >= x0 && xp <= x1 && sy >= y0 && sy <= y1 && ty >= y0 && ty <= y1) {
        this._selectedArcs.push(link);
        this._selectedIps.add(link.sourceNode.name);
        this._selectedIps.add(link.targetNode.name);
        if (link.minute < minTime) minTime = link.minute;
        if (link.minute > maxTime) maxTime = link.minute;
        minY = Math.min(minY, sy, ty); maxY = Math.max(maxY, sy, ty);
      }
    });

    if (this._selectedArcs.length > 0) {
      this._selectionTimeRange = { min: minTime, max: minTime === maxTime ? minTime + 1 : maxTime + 1 };
      const sel = {
        id: ++this._selectionIdCounter,
        timeBounds: { minTime, maxTime, minY, maxY },
        arcs: [...this._selectedArcs], ips: new Set(this._selectedIps),
        timeRange: { ...this._selectionTimeRange }
      };
      this._persistentSelections.push(sel);
      this._createPersistentSelectionVisual(sel);
      this._updateSelectionDisplay(arcPaths, widthScale);
      const msg = `${this._persistentSelections.length} selection${this._persistentSelections.length > 1 ? 's' : ''} saved`;
      if (this._onSelectionChange) this._onSelectionChange(msg);
    } else {
      this._selectionTimeRange = null;
      if (this._onSelectionChange) this._onSelectionChange('No arcs selected');
      setTimeout(() => { if (this._onSelectionChange) this._onSelectionChange('Drag to select'); }, 1500);
    }
  }

  _computeSelectionBounds(selection) {
    const { timeBounds, ips, pixelBounds } = selection;
    const forceLayout = this._getForceLayout();
    const layoutMode = this._getLayoutMode();

    if (layoutMode === 'force_layout' && forceLayout) {
      const nodePositions = forceLayout.getVisualNodePositions();
      let minX = Infinity, minYv = Infinity, maxX = -Infinity, maxYv = -Infinity;
      for (const ip of ips) {
        const pos = nodePositions.get(ip);
        if (pos) {
          if (pos.x < minX) minX = pos.x; if (pos.y < minYv) minYv = pos.y;
          if (pos.x > maxX) maxX = pos.x; if (pos.y > maxYv) maxYv = pos.y;
        }
      }
      if (minX !== Infinity) {
        const pad = 20;
        return { x0: minX - pad, y0: minYv - pad, x1: maxX + pad, y1: maxYv + pad };
      }
      return pixelBounds || null;
    }

    if (!timeBounds) return null;
    const x0 = this._xScaleLens(timeBounds.minTime), x1 = this._xScaleLens(timeBounds.maxTime);
    let minYv = Infinity, maxYv = -Infinity;
    for (const ip of ips) {
      const yPos = this._yScaleLens(ip);
      if (isFinite(yPos)) { if (yPos < minYv) minYv = yPos; if (yPos > maxYv) maxYv = yPos; }
    }
    return {
      x0, y0: minYv !== Infinity ? minYv : timeBounds.minY,
      x1, y1: maxYv !== -Infinity ? maxYv : timeBounds.maxY
    };
  }

  _createPersistentSelectionVisual(selection) {
    if (!this._multiSelectionsGroup) return;
    const { id, arcs, ips } = selection;
    const bounds = this._computeSelectionBounds(selection);
    if (!bounds) return;
    const { x0, y0, x1, y1 } = bounds;

    const selGroup = this._multiSelectionsGroup.append('g')
      .attr('class', `persistent-selection selection-${id}`)
      .attr('data-selection-id', id);

    selGroup.append('rect').attr('class', 'selection-rect')
      .attr('x', x0).attr('y', y0)
      .attr('width', Math.max(1, x1 - x0)).attr('height', Math.max(1, y1 - y0))
      .style('fill', '#28a745').style('fill-opacity', 0.1)
      .style('stroke', '#28a745').style('stroke-width', 2).style('stroke-dasharray', '5,5');

    selGroup.append('text').attr('class', 'selection-label')
      .attr('x', x0 + 5).attr('y', y0 + 14)
      .style('font-size', '10px').style('font-weight', '600').style('fill', '#28a745')
      .text(`#${id}: ${arcs.length} arcs, ${ips.size} IPs`);

    const btnContainer = selGroup.append('foreignObject').attr('class', 'selection-buttons')
      .attr('x', x1 + 5).attr('y', y0).attr('width', 120).attr('height', 60)
      .style('pointer-events', 'all');
    const btnDiv = btnContainer.append('xhtml:div')
      .style('display', 'flex').style('flex-direction', 'column').style('gap', '4px');

    btnDiv.append('xhtml:button')
      .style('padding', '4px 8px').style('border', '1px solid #28a745').style('border-radius', '4px')
      .style('background', '#28a745').style('color', '#fff').style('cursor', 'pointer')
      .style('font-size', '11px').style('font-weight', '600').style('font-family', 'inherit')
      .text('View Details')
      .on('click', event => {
        event.stopPropagation();
        if (this._onDetailsRequested) this._onDetailsRequested(selection);
      })
      .on('mouseenter', function() { d3.select(this).style('background', '#218838'); })
      .on('mouseleave', function() { d3.select(this).style('background', '#28a745'); });

    btnDiv.append('xhtml:button')
      .style('padding', '4px 8px').style('border', '1px solid #dc3545').style('border-radius', '4px')
      .style('background', '#fff').style('color', '#dc3545').style('cursor', 'pointer')
      .style('font-size', '11px').style('font-weight', '600').style('font-family', 'inherit')
      .text('Remove')
      .on('click', event => { event.stopPropagation(); this._removePersistentSelection(id); })
      .on('mouseenter', function() { d3.select(this).style('background', '#dc3545').style('color', '#fff'); })
      .on('mouseleave', function() { d3.select(this).style('background', '#fff').style('color', '#dc3545'); });
  }

  _redrawAllPersistentSelections() {
    if (this._multiSelectionsGroup) {
      this._multiSelectionsGroup.selectAll('.persistent-selection').remove();
    }
    this._persistentSelections.forEach(sel => this._createPersistentSelectionVisual(sel));
  }

  _removePersistentSelection(id) {
    this._persistentSelections = this._persistentSelections.filter(s => s.id !== id);
    if (this._multiSelectionsGroup) {
      this._multiSelectionsGroup.select(`.selection-${id}`).remove();
    }
    this._updateSelectionDisplay(this._arcPaths, this._widthScale);
    const msg = this._persistentSelections.length > 0
      ? `${this._persistentSelections.length} selection${this._persistentSelections.length > 1 ? 's' : ''} saved`
      : 'Drag to select';
    if (this._onSelectionChange) this._onSelectionChange(msg);
  }

  _updatePersistentSelectionVisuals() {
    if (!this._multiSelectionsGroup) return;
    this._persistentSelections.forEach(selection => {
      const { id } = selection;
      const bounds = this._computeSelectionBounds(selection);
      if (!bounds) return;
      const { x0, y0, x1, y1 } = bounds;
      const selGroup = this._multiSelectionsGroup.select(`.selection-${id}`);
      if (selGroup.empty()) return;
      selGroup.select('.selection-rect').attr('x', x0).attr('y', y0)
        .attr('width', Math.max(1, x1 - x0)).attr('height', Math.max(1, y1 - y0));
      selGroup.select('.selection-label').attr('x', x0 + 5).attr('y', y0 + 14);
      selGroup.select('.selection-buttons').attr('x', x1 + 5).attr('y', y0);
    });
  }

  _updateSelectionDisplay(arcPaths, widthScale) {
    if (!arcPaths) return;
    const allPersistentArcs = this._persistentSelections.flatMap(s => s.arcs);
    const hasSelection = this._selectedArcs.length > 0 || allPersistentArcs.length > 0;

    if (hasSelection) {
      arcPaths.attr('stroke-width', d => {
        const inCurrent = this._selectedArcs.some(s => s.sourceNode.name === d.sourceNode.name && s.targetNode.name === d.targetNode.name && s.minute === d.minute);
        const inPersistent = allPersistentArcs.some(s => s.sourceNode.name === d.sourceNode.name && s.targetNode.name === d.targetNode.name && s.minute === d.minute);
        if (inCurrent || inPersistent) {
          const bw = widthScale(Math.max(1, d.count));
          return Math.max(3, bw < 2 ? bw * 2.5 : bw * 1.5);
        }
        return widthScale(Math.max(1, d.count));
      });
    } else {
      arcPaths.attr('stroke-width', d => widthScale(Math.max(1, d.count)));
    }
  }

  /**
   * Compact IP positions to fill vertical space, preserving component blocks.
   * IPs ordered chronologically within each component.
   */
  _compactIPPositions(simNodes, yMap, topMargin, innerHeight, components, ipToComponent, earliestTime) {
    const numIPs = simNodes.length;
    if (numIPs === 0) return;

    if (components.length <= 1) {
      const ipArray = simNodes.map(n => ({ ip: n.id, time: earliestTime.get(n.id) || Infinity }));
      ipArray.sort((a, b) => a.time - b.time);
      const step = Math.max(MIN_IP_SPACING, Math.min((innerHeight - 25) / (ipArray.length + 1), 15));
      ipArray.forEach((item, i) => yMap.set(item.ip, topMargin + 12 + i * step));
      return;
    }

    const componentIpGroups = components.map((_, idx) => {
      const ips = simNodes
        .filter(n => ipToComponent.get(n.id) === idx)
        .map(n => ({ ip: n.id, time: earliestTime.get(n.id) || Infinity }));
      ips.sort((a, b) => a.time - b.time);
      let earliest = Infinity;
      ips.forEach(item => { if (isFinite(item.time) && item.time < earliest) earliest = item.time; });
      return { ips, earliestTime: earliest, componentIndex: idx };
    });
    componentIpGroups.sort((a, b) => a.earliestTime - b.earliestTime);

    const numGaps = components.length - 1;
    const spaceForIPs = innerHeight - 25 - numGaps * INTER_COMPONENT_GAP;
    const ipStep = Math.max(
      Math.min(spaceForIPs / (numIPs + 1), 15),
      MIN_IP_SPACING_WITHIN_COMPONENT
    );

    let currentY = topMargin + 12;
    componentIpGroups.forEach((group, idx) => {
      group.ips.forEach(item => { yMap.set(item.ip, currentY); currentY += ipStep; });
      if (idx < componentIpGroups.length - 1) currentY += INTER_COMPONENT_GAP;
    });
  }

  /**
   * Order nodes by attack grouping for optimal component separation.
   */
  _computeNodesByAttackGrouping(links) {
    const ipSet = new Set();
    for (const l of links) { ipSet.add(l.source); ipSet.add(l.target); }

    const pairKey = (a, b) => a < b ? `${a}__${b}` : `${b}__${a}`;
    const pairWeights = new Map();
    const pairHasNonNormal = new Map();
    for (const l of links) {
      const k = pairKey(l.source, l.target);
      pairWeights.set(k, (pairWeights.get(k) || 0) + (l.count || 1));
      if (l.attack && l.attack !== 'normal') pairHasNonNormal.set(k, true);
    }

    const simNodes = Array.from(ipSet).map(id => ({ id }));
    const simLinks = [], componentLinks = [];
    for (const [k, w] of pairWeights.entries()) {
      const [a, b] = k.split('__');
      simLinks.push({ source: a, target: b, value: w });
      if (pairHasNonNormal.get(k)) componentLinks.push({ source: a, target: b });
    }

    const topoComponents = findConnectedComponents(simNodes, componentLinks.length > 0 ? componentLinks : simLinks);

    // Determine primary attack per IP
    const ipAttackCounts = new Map();
    for (const l of links) {
      if (l.attack && l.attack !== 'normal') {
        for (const ip of [l.source, l.target]) {
          if (!ipAttackCounts.has(ip)) ipAttackCounts.set(ip, new Map());
          const m = ipAttackCounts.get(ip);
          m.set(l.attack, (m.get(l.attack) || 0) + (l.count || 1));
        }
      }
    }
    const primaryAttack = new Map();
    for (const ip of ipSet) {
      const m = ipAttackCounts.get(ip);
      if (!m || m.size === 0) { primaryAttack.set(ip, 'unknown'); continue; }
      let best = 'unknown', bestC = -1;
      for (const [att, c] of m.entries()) if (c > bestC) { best = att; bestC = c; }
      primaryAttack.set(ip, best);
    }

    // Merge components with same primary attack
    const compPrimaryAttack = new Map();
    topoComponents.forEach((comp, idx) => {
      const counts = new Map();
      comp.forEach(ip => {
        const a = primaryAttack.get(ip) || 'unknown';
        counts.set(a, (counts.get(a) || 0) + 1);
      });
      let best = 'unknown', bestC = -1;
      for (const [a, c] of counts.entries()) if (c > bestC) { best = a; bestC = c; }
      compPrimaryAttack.set(idx, best);
    });

    const attackToComponents = new Map();
    compPrimaryAttack.forEach((attack, idx) => {
      if (!attackToComponents.has(attack)) attackToComponents.set(attack, []);
      attackToComponents.get(attack).push(idx);
    });

    const components = [];
    const oldToNew = new Map();
    attackToComponents.forEach((idxs, _attack) => {
      const newIdx = components.length;
      const merged = [];
      idxs.forEach(old => { oldToNew.set(old, newIdx); merged.push(...topoComponents[old]); });
      components.push(merged);
    });

    const ipToComponent = new Map();
    components.forEach((comp, idx) => comp.forEach(ip => ipToComponent.set(ip, idx)));

    const yMap = new Map();

    // Earliest time per attack type
    const earliest = new Map();
    for (const l of links) {
      if (!l.attack || l.attack === 'normal') continue;
      const t = earliest.get(l.attack);
      earliest.set(l.attack, t === undefined ? l.minute : Math.min(t, l.minute));
    }

    // Group IPs by attack, sort groups by earliest time
    const groups = new Map();
    for (const ip of ipSet) {
      const att = primaryAttack.get(ip) || 'unknown';
      if (!groups.has(att)) groups.set(att, []);
      groups.get(att).push(ip);
    }
    const groupList = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'unknown' && b !== 'unknown') return 1;
      if (b === 'unknown' && a !== 'unknown') return -1;
      const ta = earliest.get(a), tb = earliest.get(b);
      if (ta === undefined && tb === undefined) return a.localeCompare(b);
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      return ta - tb;
    });

    const nodes = [];
    for (const g of groupList) {
      const arr = groups.get(g) || [];
      arr.sort((a, b) => (yMap.get(a) || 0) - (yMap.get(b) || 0));
      for (const ip of arr) nodes.push({ name: ip, group: g });
    }

    return { nodes, simNodes, simLinks, yMap, components, ipToComponent };
  }
}
