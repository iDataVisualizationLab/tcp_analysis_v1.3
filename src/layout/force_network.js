// src/layout/force_network.js
// Force-directed 2D network layout — canonical D3 live simulation pattern.

import { highlightHoveredLink, unhighlightLinks, getLinkHighlightInfo, highlightEndpointLabels, unhighlightEndpointLabels } from '../rendering/highlightUtils.js';

export class ForceNetworkLayout {
  constructor(opts) {
    this.d3 = opts.d3;
    this.svg = opts.svg;
    this.width = opts.width;
    this.height = opts.height;
    this.margin = opts.margin;
    this.colorForAttack = opts.colorForAttack;
    this.tooltip = opts.tooltip;
    this.showTooltip = opts.showTooltip;
    this.hideTooltip = opts.hideTooltip;

    // Data
    this._links = null;
    this._allIps = null;
    this._ipToComponent = null;
    this._components = null;
    this._activeLabelKey = 'attack_group';

    // Simulation + rendering state
    this._simulation = null;
    this._container = null;
    this._centerG = null;
    this._linkSel = null;
    this._gradSel = null;
    this._nodeSel = null;
    this._aggregated = null;
    this._nodeData = null;
    this._linkData = null;
    this._simLinks = null;
    this._radiusScale = null;
    this._linkWidthScale = null;
    this._cx = 0;
    this._cy = 0;
    this._drawWidth = 0;
    this._drawHeight = 0;
    this._fitScale = 1;
    this._fitContentCx = 0;
    this._fitContentCy = 0;
  }

  // ───────────────────────── Data ─────────────────────────

  setData(linksWithNodes, allIps, ipToComponent, components, activeLabelKey) {
    this._links = linksWithNodes;
    this._allIps = allIps;
    this._ipToComponent = ipToComponent;
    this._components = components;
    this._activeLabelKey = activeLabelKey || 'attack_group';
  }

  // ───────────────────── Aggregation ──────────────────────

  aggregateForTimeRange(timeRange) {
    const labelKey = this._activeLabelKey;
    const agg = new Map();

    for (const l of this._links) {
      if (timeRange) {
        if (l.minute < timeRange.min || l.minute > timeRange.max) continue;
      }

      const attackType = l[labelKey] || 'normal';
      const [ipA, ipB] = l.sourceIp < l.targetIp
        ? [l.sourceIp, l.targetIp]
        : [l.targetIp, l.sourceIp];
      const key = `${ipA}::${ipB}::${attackType}`;

      if (agg.has(key)) {
        agg.get(key).count += (l.count || 1);
      } else {
        // Canonical pair for grouping, but preserve original direction for gradient
        agg.set(key, {
          sourceIp: ipA, targetIp: ipB,
          origSourceIp: l.sourceIp, origTargetIp: l.targetIp,
          attackType, count: l.count || 1
        });
      }
    }

    this._aggregated = agg;
    return agg;
  }

  // ──────────────────── Build Data ──────────────────────

  _buildDataFromAggregation() {
    const d3 = this.d3;
    const agg = this._aggregated;

    // Unique IPs
    const ipSet = new Set();
    for (const entry of agg.values()) {
      ipSet.add(entry.sourceIp);
      ipSet.add(entry.targetIp);
    }

    // IP degrees
    const ipDegree = new Map();
    for (const entry of agg.values()) {
      ipDegree.set(entry.sourceIp, (ipDegree.get(entry.sourceIp) || 0) + 1);
      ipDegree.set(entry.targetIp, (ipDegree.get(entry.targetIp) || 0) + 1);
    }

    const maxDeg = Math.max(1, ...ipDegree.values());
    this._radiusScale = d3.scaleSqrt().domain([0, maxDeg]).range([5, 20]);

    // Nodes
    const nodeById = new Map();
    this._nodeData = [];
    for (const ip of ipSet) {
      const nd = { id: ip, degree: ipDegree.get(ip) || 0 };
      nodeById.set(ip, nd);
      this._nodeData.push(nd);
    }

    // Unique pair links for simulation force
    const pairCounts = new Map();
    for (const entry of agg.values()) {
      const pk = entry.sourceIp < entry.targetIp
        ? `${entry.sourceIp}::${entry.targetIp}`
        : `${entry.targetIp}::${entry.sourceIp}`;
      pairCounts.set(pk, (pairCounts.get(pk) || 0) + entry.count);
    }
    this._simLinks = [];
    for (const [pk, cnt] of pairCounts) {
      const [s, t] = pk.split('::');
      this._simLinks.push({ source: s, target: t, value: cnt });
    }

    // Parallel links for rendering — grouped by canonical pair
    const pairBuckets = new Map();
    for (const entry of agg.values()) {
      const pk = entry.sourceIp < entry.targetIp
        ? `${entry.sourceIp}::${entry.targetIp}`
        : `${entry.targetIp}::${entry.sourceIp}`;
      if (!pairBuckets.has(pk)) pairBuckets.set(pk, []);
      pairBuckets.get(pk).push(entry);
    }

    let maxCount = 1;
    for (const entry of agg.values()) {
      if (entry.count > maxCount) maxCount = entry.count;
    }
    this._linkWidthScale = d3.scaleSqrt().domain([1, maxCount]).range([1.5, 8]);

    this._linkData = [];
    for (const [, entries] of pairBuckets) {
      const total = entries.length;
      entries.forEach((entry, idx) => {
        const offset = (idx - (total - 1) / 2) * 4;
        this._linkData.push({
          sourceNode: nodeById.get(entry.sourceIp),
          targetNode: nodeById.get(entry.targetIp),
          attackType: entry.attackType,
          count: entry.count,
          sourceIp: entry.sourceIp,
          targetIp: entry.targetIp,
          // Original traffic direction (for gradient): is canonical source the real source?
          directionReversed: (entry.origSourceIp || entry.sourceIp) !== entry.sourceIp,
          parallelOffset: offset,
        });
      });
    }
  }

  // ──────────────────── Rendering ──────────────────────

  /**
   * Render with live simulation. Optionally accepts starting positions
   * (absolute SVG coords) so nodes animate from those positions.
   * @param {d3.Selection} container – the <g> to render into
   * @param {Map<string,{x,y}>|null} startPositions – absolute SVG coords
   */
  render(container, startPositions, { staticStart = false } = {}) {
    const d3 = this.d3;

    // Stop any existing simulation
    if (this._simulation) {
      this._simulation.stop();
      this._simulation = null;
    }

    this._container = container;
    container.selectAll('*').remove();

    if (!this._aggregated || this._aggregated.size === 0) return;

    this._buildDataFromAggregation();

    // Drawing area
    const viewportH = window.innerHeight || this.height;
    const usableHeight = Math.max(400, viewportH - 160);
    const drawWidth = this._drawWidth = this.width - this.margin.left - this.margin.right;
    const drawHeight = this._drawHeight = usableHeight;

    this.svg.attr('height', this.margin.top + drawHeight + this.margin.bottom);

    // Center of drawing area
    const cx = this._cx = this.margin.left + drawWidth / 2;
    const cy = this._cy = this.margin.top + drawHeight / 2;

    // Set initial positions (convert from absolute to centered coords)
    if (startPositions) {
      for (const nd of this._nodeData) {
        const sp = startPositions.get(nd.id);
        if (sp) {
          nd.x = sp.x - cx;
          nd.y = sp.y - cy;
        }
      }
    }

    // Centered group
    const g = this._centerG = container.append('g')
      .attr('transform', `translate(${cx},${cy})`);

    // --- Directional gradients for links ---
    const NEUTRAL_GREY = '#999';
    const gradDefs = g.append('defs');
    const gradSel = gradDefs.selectAll('linearGradient')
      .data(this._linkData)
      .join('linearGradient')
      .attr('id', (d, i) => `force-grad-${i}`)
      .attr('gradientUnits', 'userSpaceOnUse');
    gradSel.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', d => d.directionReversed ? NEUTRAL_GREY : this.colorForAttack(d.attackType));
    gradSel.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', d => d.directionReversed ? this.colorForAttack(d.attackType) : NEUTRAL_GREY);

    // --- Links (behind nodes) ---
    const linkSel = g.append('g')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(this._linkData)
      .join('line')
      .attr('class', 'force-link')
      .attr('stroke', (d, i) => `url(#force-grad-${i})`)
      .attr('stroke-width', d => this._linkWidthScale(d.count));

    // --- Nodes ---
    const nodeSel = g.append('g')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll('g')
      .data(this._nodeData, d => d.id)
      .join('g')
      .attr('class', 'force-node');

    nodeSel.append('circle')
      .attr('r', d => this._radiusScale(d.degree))
      .attr('fill', d => this._nodeColor(d));

    nodeSel.append('text')
      .attr('x', d => this._radiusScale(d.degree) + 6)
      .attr('dy', '0.35em')
      .style('fill', '#333')
      .style('stroke', 'none')
      .style('font-size', '11px')
      .text(d => d.id);

    this._linkSel = linkSel;
    this._gradSel = gradSel;
    this._nodeSel = nodeSel;

    // --- Force simulation ---
    const simulation = d3.forceSimulation(this._nodeData)
      .force('link', d3.forceLink(this._simLinks).id(d => d.id)
        .distance(80).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('x', d3.forceX())
      .force('y', d3.forceY())
      .force('collide', d3.forceCollide(d => this._radiusScale(d.degree) + 5))
      .on('tick', () => this._ticked());

    this._simulation = simulation;

    if (staticStart) {
      // Stop the timer so simulation doesn't animate; position DOM once
      simulation.stop();
      this._ticked();
    }

    // --- Drag ---
    nodeSel.call(d3.drag()
      .on('start', function (event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
        d3.select(this).classed('dragging', true);
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', function (event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        d3.select(this).classed('dragging', false);
      })
    );

    // --- Hover interactions ---
    this._attachHoverInteractions();
  }

  // ──────────────────── Tick ──────────────────────

  _ticked() {
    const linkSel = this._linkSel;
    const gradSel = this._gradSel;
    const nodeSel = this._nodeSel;
    if (!linkSel || !nodeSel) return;

    // Update links and gradient endpoints with parallel offsets
    linkSel.each(function (d) {
      const sx = d.sourceNode.x, sy = d.sourceNode.y;
      const tx = d.targetNode.x, ty = d.targetNode.y;
      const dx = tx - sx, dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = (-dy / len) * d.parallelOffset;
      const ny = (dx / len) * d.parallelOffset;
      this.setAttribute('x1', sx + nx);
      this.setAttribute('y1', sy + ny);
      this.setAttribute('x2', tx + nx);
      this.setAttribute('y2', ty + ny);
    });

    if (gradSel) {
      gradSel.each(function (d) {
        const sx = d.sourceNode.x, sy = d.sourceNode.y;
        const tx = d.targetNode.x, ty = d.targetNode.y;
        const dx = tx - sx, dy = ty - sy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = (-dy / len) * d.parallelOffset;
        const ny = (dx / len) * d.parallelOffset;
        this.setAttribute('x1', sx + nx);
        this.setAttribute('y1', sy + ny);
        this.setAttribute('x2', tx + nx);
        this.setAttribute('y2', ty + ny);
      });
    }

    // Update nodes
    nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);

    // Auto-fit: scale the centered group so all nodes stay within the drawing area
    this._autoFit();
  }

  _autoFit() {
    if (!this._centerG || !this._nodeData || this._nodeData.length === 0) return;

    const labelPad = 80; // extra space for IP label text
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const d of this._nodeData) {
      const r = this._radiusScale(d.degree);
      xMin = Math.min(xMin, d.x - r);
      xMax = Math.max(xMax, d.x + r + labelPad);
      yMin = Math.min(yMin, d.y - r);
      yMax = Math.max(yMax, d.y + r);
    }

    const contentW = (xMax - xMin) || 1;
    const contentH = (yMax - yMin) || 1;
    const contentCx = (xMin + xMax) / 2;
    const contentCy = (yMin + yMax) / 2;

    const scaleX = this._drawWidth / contentW;
    const scaleY = this._drawHeight / contentH;
    const scale = Math.min(scaleX, scaleY, 1.5); // cap so small graphs don't over-zoom

    this._fitScale = scale;
    this._fitContentCx = contentCx;
    this._fitContentCy = contentCy;

    this._centerG.attr('transform',
      `translate(${this._cx},${this._cy}) scale(${scale}) translate(${-contentCx},${-contentCy})`);
  }

  // ──────────────────── Hover ──────────────────────

  _attachHoverInteractions() {
    const self = this;

    // Node hover
    this._nodeSel
      .on('mouseover', function (event, d) {
        self._linkSel
          .attr('stroke-opacity', l =>
            (l.sourceIp === d.id || l.targetIp === d.id) ? 1 : 0.15)
          .attr('stroke-width', l => {
            const base = self._linkWidthScale(l.count);
            return (l.sourceIp === d.id || l.targetIp === d.id)
              ? Math.max(base * 1.5, 3) : base;
          });
        self._nodeSel.select('circle')
          .attr('opacity', n => {
            if (n.id === d.id) return 1;
            for (const l of self._linkData) {
              if ((l.sourceIp === d.id && l.targetIp === n.id) ||
                  (l.targetIp === d.id && l.sourceIp === n.id)) return 1;
            }
            return 0.3;
          });
        self.showTooltip(self.tooltip, event,
          `<strong>${d.id}</strong><br>Connections: ${d.degree}`);
      })
      .on('mousemove', function (event) {
        if (self.tooltip && self.tooltip.style.display !== 'none') {
          self.tooltip.style.left = (event.clientX + 10) + 'px';
          self.tooltip.style.top = (event.clientY + 10) + 'px';
        }
      })
      .on('mouseout', function () {
        unhighlightLinks(self._linkSel, self._linkWidthScale);
        self._nodeSel.select('circle').attr('opacity', 1);
        self.hideTooltip(self.tooltip);
      });

    // Link hover — shared highlight logic with timearcs
    this._linkSel
      .on('mouseover', function (event, d) {
        // Dim all links, highlight hovered (shared with timearcs)
        highlightHoveredLink(self._linkSel, d, this, self._linkWidthScale, self.d3);

        // Compute attack color (shared with timearcs)
        const { activeIPs, attackColor } = getLinkHighlightInfo(d, self.colorForAttack);

        // Highlight source node with attack color, keep destination grey (like link gradient)
        const origSource = d.directionReversed ? d.targetIp : d.sourceIp;
        self._nodeSel.select('circle')
          .attr('fill', n => {
            if (n.id === origSource) return attackColor;
            if (activeIPs.has(n.id)) return '#999';
            return self._nodeColor(n);
          })
          .attr('opacity', n => activeIPs.has(n.id) ? 1 : 0.3);
        highlightEndpointLabels(self._nodeSel.select('text'), activeIPs, attackColor);

        self.showTooltip(self.tooltip, event,
          `<strong>${d.sourceIp} \u2194 ${d.targetIp}</strong><br>` +
          `Attack: ${d.attackType}<br>Count: ${d.count}`);
      })
      .on('mousemove', function (event) {
        if (self.tooltip && self.tooltip.style.display !== 'none') {
          self.tooltip.style.left = (event.clientX + 10) + 'px';
          self.tooltip.style.top = (event.clientY + 10) + 'px';
        }
      })
      .on('mouseout', function () {
        // Restore links (shared with timearcs)
        unhighlightLinks(self._linkSel, self._linkWidthScale);

        // Restore nodes
        self._nodeSel.select('circle')
          .attr('fill', n => self._nodeColor(n))
          .attr('opacity', 1);
        unhighlightEndpointLabels(self._nodeSel.select('text'));

        self.hideTooltip(self.tooltip);
      });
  }

  // ──────────────────── Node Color ──────────────────────

  _nodeColor(nodeData) {
    if (!this._aggregated) return '#999';
    // Only color nodes that are the original traffic source (matches link gradient)
    let bestAttack = null, bestCount = 0;
    for (const entry of this._aggregated.values()) {
      const origSrc = entry.origSourceIp || entry.sourceIp;
      if (origSrc === nodeData.id) {
        if (entry.count > bestCount) {
          bestCount = entry.count;
          bestAttack = entry.attackType;
        }
      }
    }
    return bestAttack ? this.colorForAttack(bestAttack) : '#999';
  }

  // ─────────────────── Update Methods ─────────────────────

  /**
   * Re-aggregate for a new time range and re-render with live simulation.
   * Preserves current node positions so transitions are smooth.
   */
  updateTimeFilter(timeRange) {
    if (!this._container) return;

    // Save current positions (convert from centered to absolute)
    const currentPositions = new Map();
    if (this._nodeData) {
      for (const nd of this._nodeData) {
        currentPositions.set(nd.id, {
          x: nd.x + this._cx,
          y: nd.y + this._cy
        });
      }
    }

    this.aggregateForTimeRange(timeRange);
    this.render(this._container, currentPositions);
  }

  /**
   * Show/hide links by attack type.
   */
  updateVisibleAttacks(visibleSet) {
    if (!this._linkSel || !this._nodeSel) return;

    this._linkSel
      .style('display', d => visibleSet.has(d.attackType) ? null : 'none');

    const visibleIps = new Set();
    for (const d of this._linkData) {
      if (visibleSet.has(d.attackType)) {
        visibleIps.add(d.sourceIp);
        visibleIps.add(d.targetIp);
      }
    }
    this._nodeSel
      .style('display', d => visibleIps.has(d.id) ? null : 'none');
  }

  /**
   * Pre-run the force simulation to completion and return final positions.
   * Call after setData() + aggregateForTimeRange().
   * @param {Map<string,{x,y}>|null} startPositions – absolute SVG coords
   * @returns {{ rawPositions: Map, visualPositions: Map }}
   *   rawPositions: centered coords + cx/cy (pass to render as startPositions)
   *   visualPositions: screen positions after autoFit (use for arc animation targets)
   */
  precalculate(startPositions) {
    const d3 = this.d3;

    const viewportH = window.innerHeight || this.height;
    const usableHeight = Math.max(400, viewportH - 160);
    this._drawWidth = this.width - this.margin.left - this.margin.right;
    this._drawHeight = usableHeight;
    this._cx = this.margin.left + this._drawWidth / 2;
    this._cy = this.margin.top + this._drawHeight / 2;

    this._buildDataFromAggregation();

    if (startPositions) {
      for (const nd of this._nodeData) {
        const sp = startPositions.get(nd.id);
        if (sp) {
          nd.x = sp.x - this._cx;
          nd.y = sp.y - this._cy;
        }
      }
    }

    // Create temporary simulation with identical forces, run to completion
    const sim = d3.forceSimulation(this._nodeData)
      .force('link', d3.forceLink(this._simLinks).id(d => d.id)
        .distance(80).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('x', d3.forceX())
      .force('y', d3.forceY())
      .force('collide', d3.forceCollide(d => this._radiusScale(d.degree) + 5))
      .stop();

    const n = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
    for (let i = 0; i < n; ++i) sim.tick();

    // Raw positions (for render's startPositions)
    const rawPositions = new Map();
    for (const nd of this._nodeData) {
      rawPositions.set(nd.id, { x: nd.x + this._cx, y: nd.y + this._cy });
    }

    // Compute autoFit transform to get visual (on-screen) positions
    const labelPad = 80;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const d of this._nodeData) {
      const r = this._radiusScale(d.degree);
      xMin = Math.min(xMin, d.x - r);
      xMax = Math.max(xMax, d.x + r + labelPad);
      yMin = Math.min(yMin, d.y - r);
      yMax = Math.max(yMax, d.y + r);
    }
    const contentW = (xMax - xMin) || 1;
    const contentH = (yMax - yMin) || 1;
    const contentCx = (xMin + xMax) / 2;
    const contentCy = (yMin + yMax) / 2;
    const scaleX = this._drawWidth / contentW;
    const scaleY = this._drawHeight / contentH;
    const scale = Math.min(scaleX, scaleY, 1.5);

    const visualPositions = new Map();
    for (const nd of this._nodeData) {
      visualPositions.set(nd.id, {
        x: this._cx + scale * (nd.x - contentCx),
        y: this._cy + scale * (nd.y - contentCy)
      });
    }

    return { rawPositions, visualPositions };
  }

  /**
   * Returns node positions accounting for the autoFit scale transform,
   * i.e. where nodes actually appear on screen.
   */
  getVisualNodePositions() {
    if (!this._nodeData) return new Map();
    const s = this._fitScale || 1;
    const ccx = this._fitContentCx || 0;
    const ccy = this._fitContentCy || 0;
    const m = new Map();
    for (const nd of this._nodeData) {
      m.set(nd.id, {
        x: this._cx + s * (nd.x - ccx),
        y: this._cy + s * (nd.y - ccy)
      });
    }
    return m;
  }

  getNodePositions() {
    if (!this._nodeData) return new Map();
    const m = new Map();
    for (const nd of this._nodeData) {
      m.set(nd.id, { x: nd.x + this._cx, y: nd.y + this._cy });
    }
    return m;
  }

  // ───────────────────── Cleanup ──────────────────────────

  destroy() {
    if (this._simulation) {
      this._simulation.stop();
      this._simulation = null;
    }
    if (this._container) {
      this._container.selectAll('*').remove();
    }
    this._linkSel = null;
    this._gradSel = null;
    this._nodeSel = null;
    this._centerG = null;
    this._nodeData = null;
    this._linkData = null;
    this._simLinks = null;
    this._aggregated = null;
  }
}
